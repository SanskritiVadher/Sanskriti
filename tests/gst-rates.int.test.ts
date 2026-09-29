import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, updateBusinessInfo, updateGstInfo } from "@/lib/services/company";
import { createParty } from "@/lib/services/parties";
import { createProduct } from "@/lib/services/inventory";
import { createSale } from "@/lib/services/sales";
import { addRule, rateProblems, setGstStrict, confirmProductRates, gstReview, parsePeriod } from "@/lib/services/gst";
import { gstinCheckChar } from "@/lib/gst/gstin";

afterAll(async () => { await pool.end(); });
const g = (b: string) => b + gstinCheckChar(b);
let cid = "", uid = "", cus = "", bat = "", bat2 = "", fan = "";
const sell = (productId: string) => createSale(db, { companyId: cid, userId: uid, partyId: cus, date: "2026-09-25", lines: [{ productId, qty: "1", rate: "100" }] });

beforeAll(async () => {
  const r = await registerOwner(db, { name: "R", email: `rt_${Date.now()}@t.in`, password: "secret123", businessName: "R" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "R", stateCode: "21" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  cus = (await createParty(db, cid, uid, "CUSTOMER", { name: "C" })).id;
  const o = { openingQty: "10", openingRate: "50", openingDate: "2026-04-01" };
  bat = (await createProduct(db, cid, uid, { name: "Battery A", hsn: "85072000", gstRate: "18", ...o })).id;
  bat2 = (await createProduct(db, cid, uid, { name: "Battery B", hsn: "85072000", gstRate: "28", ...o })).id;
  fan = (await createProduct(db, cid, uid, { name: "Fan", hsn: "8414", gstRate: "18", ...o })).id;
});

describe("GST rate checks", () => {
  it("finds same-HSN clashes and unconfirmed rates", async () => {
    const p = await rateProblems(db, cid, "2026-09-25");
    expect(p.hsnConflicts).toHaveLength(1); expect(p.hsnConflicts[0].hsn).toBe("85072000");
    expect(p.unconfirmed).toHaveLength(3);
    const review = await gstReview(db, cid, parsePeriod("2026-09"));
    expect(review.some((r) => /different GST rates/.test(r.what))).toBe(true);
  });
  it("an unchecked rate-table rule is ignored; a checked one flags mismatches", async () => {
    await addRule(db, cid, uid, { hsnPrefix: "8507", description: "Batteries", rate: "18", effectiveFrom: "2025-09-22", status: "SECONDARY_SOURCE" });
    expect((await rateProblems(db, cid, "2026-09-25")).ruleMismatch).toHaveLength(0);
    await addRule(db, cid, uid, { hsnPrefix: "850720", description: "Lead-acid", rate: "18", effectiveFrom: "2025-09-22", status: "USER_CONFIRMED" });
    const m = (await rateProblems(db, cid, "2026-09-25")).ruleMismatch;
    expect(m.map((x) => x.p.name)).toEqual(["Battery B"]);
    const s = await sell(bat2);
    expect(s.warnings.join(" ")).toMatch(/28%.*rate table says 18%/);
  });
  it("bulk confirm needs a note and refuses a product that disagrees with the checked table", async () => {
    await expect(confirmProductRates(db, cid, uid, [bat], "")).rejects.toThrow(/checked them against/);
    await expect(confirmProductRates(db, cid, uid, [bat, bat2], "SF bill 12")).rejects.toThrow(/Battery B/);
    expect(await confirmProductRates(db, cid, uid, [bat], "SF bill 12")).toBe(1);
    const log = await db.execute(sql`SELECT reason FROM audit_logs WHERE company_id = ${cid} AND action = 'product.gst_confirm'`);
    expect(log.rows[0]).toMatchObject({ reason: "SF bill 12" });
  });
  it("strict mode: only confirmed, matching rates can be billed", async () => {
    await setGstStrict(db, cid, uid, true);
    await expect(sell(fan)).rejects.toThrow(/isn't confirmed/);
    await expect(sell(bat2)).rejects.toThrow(/isn't confirmed|rate table/);
    const ok = await sell(bat);
    expect(ok.invoice.id).toBeTruthy();
    await setGstStrict(db, cid, uid, false);
    expect((await sell(fan)).warnings.join(" ")).toMatch(/not confirmed/);
    const a = await db.execute(sql`SELECT action FROM audit_logs WHERE company_id = ${cid} AND action LIKE 'gst.strict%' ORDER BY created_at`);
    expect(a.rows.map((r) => (r as { action: string }).action)).toEqual(["gst.strict_on", "gst.strict_off"]);
  });
  it("products not changed by any of this", async () => {
    const p = await db.query.products.findFirst({ where: eq(schema.products.id, bat2) });
    expect(p!.gstRate).toBe("28.00");
  });
});
