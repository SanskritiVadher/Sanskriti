import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, updateBusinessInfo, updateGstInfo, addBrand, addUser } from "@/lib/services/company";
import { createParty, recordCustomerPayment } from "@/lib/services/parties";
import { createProduct } from "@/lib/services/inventory";
import { createSale } from "@/lib/services/sales";
import { createBill } from "@/lib/services/purchases";
import { createCreditNote, returnableLines } from "@/lib/services/notes";
import { recordPayment, setOpeningBalances } from "@/lib/services/vouchers";
import { computeRatios, statusFor, saveTargets, facts } from "@/lib/analytics/ratios";
import { profitability } from "@/lib/analytics/profitability";
import { stockInsights, saveReorderSettings } from "@/lib/analytics/stock";
import { businessHealth } from "@/lib/analytics/health";
import { balanceSheet, profitAndLoss } from "@/lib/accounting/statements";
import { gstinCheckChar } from "@/lib/gst/gstin";
import { D } from "@/lib/money";

afterAll(async () => { await pool.end(); });
const g = (b: string) => b + gstinCheckChar(b);
let cid = "", uid = "", staff = "", bat = "", fan = "", dead = "", ravi = "", sahu = "";
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

beforeAll(async () => {
  const r = await registerOwner(db, { name: "BI", email: `bi_${Date.now()}@t.in`, password: "secret123", businessName: "BI Co" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "BI Co", stateCode: "21" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  const bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  const acc = Object.fromEntries((await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })).filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
  await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [bank]: "500000" } });
  staff = (await addUser(db, cid, uid, { name: "Salesman Raju", email: `raju_${Date.now()}@t.in`, password: "secret123", role: "SALESPERSON" })).id;
  const sf = await addBrand(db, cid, uid, "SF Sonic"), us = await addBrand(db, cid, uid, "Usha");
  bat = (await createProduct(db, cid, uid, { name: "Battery", brandId: sf.id, hsn: "8507", gstRate: "18", gstConfirmed: true })).id;
  fan = (await createProduct(db, cid, uid, { name: "Fan", brandId: us.id, hsn: "8414", gstRate: "18", gstConfirmed: true })).id;
  dead = (await createProduct(db, cid, uid, { name: "Old Inverter", hsn: "8504", gstRate: "18", gstConfirmed: true, openingQty: "4", openingRate: "9000", openingDate: "2026-04-01" })).id;
  const sup = await createParty(db, cid, uid, "SUPPLIER", { name: "Sup", gstin: g("21BBBBB2222B1Z"), creditDays: "30" });
  ravi = (await createParty(db, cid, uid, "CUSTOMER", { name: "Ravi", gstin: g("21CCCCC3333C1Z"), creditDays: "30" })).id;
  sahu = (await createParty(db, cid, uid, "CUSTOMER", { name: "Sahu", creditDays: "15" })).id;
  const small = [(await createParty(db, cid, uid, "CUSTOMER", { name: "C3" })).id, (await createParty(db, cid, uid, "CUSTOMER", { name: "C4" })).id];
  // July–Sept: steady business; batteries sell ~1/day, fans ~0.5/day; Sahu buys fans at a thin margin.
  await createBill(db, { companyId: cid, userId: uid, partyId: sup.id, billNumber: "B1", date: "2026-07-01", lines: [{ productId: bat, qty: "120", rate: "4000" }, { productId: fan, qty: "60", rate: "1800" }] });
  let d = "2026-07-02";
  for (let i = 0; i < 45; i++) {
    await createSale(db, { companyId: cid, userId: i % 3 === 0 ? staff : uid, partyId: i % 2 ? ravi : small[i % 2 === 0 && i % 4 === 0 ? 0 : 1], date: d, lines: [{ productId: bat, qty: "2", rate: "5000" }] });
    if (i % 3 === 0) await createSale(db, { companyId: cid, userId: uid, partyId: sahu, date: d, lines: [{ productId: fan, qty: "3", rate: "1900" }], creditOverrideReason: "x" });
    d = addDays(d, 2);
  }
  const lastRavi = await db.query.salesInvoices.findFirst({ where: eq(schema.salesInvoices.partyId, ravi) });
  const [l] = await returnableLines(db, "CREDIT_NOTE", lastRavi!.id);
  await createCreditNote(db, { companyId: cid, userId: uid, invoiceId: lastRavi!.id, date: "2026-09-20", reason: "faulty", lines: [{ sourceLineId: l.id, qty: "1" }] });
  await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: ravi, cashBankId: bank, amount: "150000", date: "2026-09-15" });
  await recordPayment(db, { companyId: cid, userId: uid, date: "2026-09-30", amount: "20000", cashBankId: bank, toAccountId: acc.RENT });
});

describe("ratios", () => {
  it("every ratio is traceable: value = numerator ÷ denominator; sources and formula present", async () => {
    const { ratios, facts: f } = await computeRatios(db, cid, "2026-09-01", "2026-09-30");
    for (const r of ratios) {
      expect(r.formula.length).toBeGreaterThan(3); expect(r.sources.length).toBeGreaterThan(0);
      if (r.value && r.numerator && r.denominator) {
        const expected = r.unit === "%" ? r.numerator.value.div(r.denominator.value).mul(100) : r.numerator.value.div(r.denominator.value);
        expect([r.key, r.value.minus(expected).abs().lte(r.unit === "days" ? 0.5 : r.unit === "%" ? 0.05 : 0.005)]).toEqual([r.key, true]);
      }
      if (r.value == null) expect([r.key, !!r.insufficient]).toEqual([r.key, true]);
    }
    const cur = ratios.find((r) => r.key === "current")!;
    const bs = await balanceSheet(db, cid, "2026-09-30");
    expect(cur.numerator!.value.toFixed(2)).toBe(bs.currentAssets.toFixed(2));
    const gm = ratios.find((r) => r.key === "gross_margin")!;
    const pl = await profitAndLoss(db, cid, "2026-09-01", "2026-09-30");
    expect(gm.numerator!.value.toFixed(2)).toBe(pl.grossProfit.toFixed(2));
    const ccc = ratios.find((r) => r.key === "ccc")!, dso = ratios.find((r) => r.key === "dso")!, dio = ratios.find((r) => r.key === "dio")!, dpo = ratios.find((r) => r.key === "dpo")!;
    if (ccc.value) expect(ccc.value.toFixed(0)).toBe(dso.value!.plus(dio.value!).minus(dpo.value!).toFixed(0));
    expect(f.activity).toBeGreaterThan(5);
  });
  it("uses the right benchmark source and never invents: DSO vs credit terms; targets override", async () => {
    let { ratios } = await computeRatios(db, cid, "2026-09-01", "2026-09-30");
    expect(ratios.find((r) => r.key === "dso")!.benchmark!.source).toBe("YOUR_CREDIT_TERMS");
    expect(ratios.find((r) => r.key === "icr")!.insufficient).toMatch(/No loan interest/);
    await saveTargets(db, cid, { current: 5 });
    ({ ratios } = await computeRatios(db, cid, "2026-09-01", "2026-09-30"));
    const cur = ratios.find((r) => r.key === "current")!;
    expect(cur.benchmark!.source).toBe("YOUR_TARGET"); expect(cur.statusReason).toMatch(/your target of 5.00/);
  });
  it("refuses to compute from too little activity", async () => {
    const { ratios } = await computeRatios(db, cid, "2026-10-01", "2026-10-05");
    expect(ratios.every((r) => r.value === null)).toBe(true);
    expect(ratios[0].insufficient).toMatch(/Not enough activity/);
  });
  it("status bands", () => {
    expect(statusFor(D("1.5"), D("1.2"), true)).toBe("HEALTHY");
    expect(statusFor(D("1.1"), D("1.2"), true)).toBe("WATCH");
    expect(statusFor(D("0.5"), D("1.2"), true)).toBe("CRITICAL");
    expect(statusFor(D("40"), D("30"), false)).toBe("CAUTION"); // 30/40 = 0.75
  });
  it("facts reconcile with documents", async () => {
    const f = await facts(db, cid, "2026-07-01", "2026-09-30");
    const inv = await db.query.salesInvoices.findMany({ where: eq(schema.salesInvoices.companyId, cid) });
    const cn = await db.query.gstNotes.findMany({ where: eq(schema.gstNotes.companyId, cid) });
    expect(f.salesGross.toFixed(2)).toBe(inv.reduce((s, i) => s.plus(i.total), D(0)).minus(cn.reduce((s, n) => s.plus(n.total), D(0))).toFixed(2));
  });
});

describe("profitability", () => {
  it("product/brand/customer/salesperson totals all equal the P&L gross profit", async () => {
    const pl = await profitAndLoss(db, cid, "2026-07-01", "2026-09-30");
    const salesOnlyGp = pl.netSales.minus(pl.cogs.filter((c) => c.system_key === "COGS").reduce((s, c) => s.plus(c.amount), D(0)));
    for (const by of ["product", "brand", "customer", "salesperson"] as const) {
      const r = await profitability(db, cid, "2026-07-01", "2026-09-30", by);
      expect([by, r.totProfit.toFixed(2)]).toEqual([by, salesOnlyGp.toFixed(2)]);
      expect([by, r.totSales.toFixed(2)]).toEqual([by, pl.netSales.toFixed(2)]);
    }
    const c = await profitability(db, cid, "2026-07-01", "2026-09-30", "customer");
    expect(c.rows.find((x) => x.name === "Sahu")!.flag).toMatch(/low margin|Below-average margin/);
    const s = await profitability(db, cid, "2026-07-01", "2026-09-30", "salesperson");
    expect(s.rows.map((x) => x.name).sort()).toEqual(["BI", "Salesman Raju"]);
  });
});

describe("stock insights", () => {
  it("labels dead stock, computes pace and a reorder suggestion only with enough history", async () => {
    await saveReorderSettings(db, cid, { leadDays: 7, coverDays: 30, safetyDays: 5, lookbackDays: 90 });
    const s = await stockInsights(db, cid, "2026-09-30");
    const b = s.items.find((x) => x.id === bat)!, dd = s.items.find((x) => x.id === dead)!;
    expect(dd.health).toBe("DEAD");
    expect(b.enoughHistory).toBe(true); expect(b.basis).toBe("FORECAST");
    // 90-day window = 3 Jul–30 Sep: 90 sold − 2 on 2 Jul (outside) − 1 returned = 87; history capped at 90 days
    expect(b.soldQty.toString()).toBe("87");
    expect(b.avgDaily!.toFixed(2)).toBe(D(87).div(90).toFixed(2));
    expect(b.reorderPoint!.toString()).toBe(D(87).div(90).mul(12).toDecimalPlaces(0, 2).toString()); // lead 7 + safety 5
    expect(s.summary.total.toFixed(2)).toBe(s.items.reduce((a, x) => a.plus(x.value), D(0)).toFixed(2));
  });
  it("new products have no forecast", async () => {
    const p = await createProduct(db, cid, uid, { name: "Brand New", gstRate: "18", openingQty: "5", openingRate: "100", openingDate: "2026-09-25" });
    const s = await stockInsights(db, cid, "2026-09-30");
    const x = s.items.find((i) => i.id === p.id)!;
    expect(x.health).toBe("NEW"); expect(x.basis).toBe("NONE"); expect(x.suggestQty).toBeNull();
  });
});

describe("business health", () => {
  it("returns six parts, each with a state and a link, no single score", async () => {
    const parts = await businessHealth(db, cid, "2026-09-01", "2026-09-30");
    expect(parts.map((p) => p.key)).toEqual(["cash", "receivables", "profit", "stock", "debt", "hygiene"]);
    for (const p of parts) { expect(p.state.length).toBeGreaterThan(5); expect(p.href).toMatch(/^\//); }
    expect(parts.find((p) => p.key === "stock")!.state).toMatch(/slow or not moving/);
  });
});
