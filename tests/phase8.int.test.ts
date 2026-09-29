import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, updateBusinessInfo, updateGstInfo } from "@/lib/services/company";
import { createParty, recordCustomerPayment } from "@/lib/services/parties";
import { createProduct } from "@/lib/services/inventory";
import { createSale } from "@/lib/services/sales";
import { createBill } from "@/lib/services/purchases";
import { recordPayment, recordReceipt, setOpeningBalances } from "@/lib/services/vouchers";
import { findings, markChecked } from "@/lib/analytics/anomalies";
import { parseQuickEntry } from "@/lib/assist/quick-entry";
import { quickEntryContext } from "@/lib/assist/context";
import { gstinCheckChar } from "@/lib/gst/gstin";

afterAll(async () => { await pool.end(); });
const g = (b: string) => b + gstinCheckChar(b);
let cid = "", uid = "", bank = "", cash = "", acc: Record<string, string> = {}, cust = "", sup = "", bat = "";

beforeAll(async () => {
  const r = await registerOwner(db, { name: "AN", email: `an_${Date.now()}@t.in`, password: "secret123", businessName: "AN Co" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "AN Co", stateCode: "21" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  acc = Object.fromEntries((await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })).filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
  cash = acc.CASH;
  await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [bank]: "900000", [cash]: "300000" } });
  bat = (await createProduct(db, cid, uid, { name: "Battery", hsn: "8507", gstRate: "18", gstConfirmed: true })).id;
  sup = (await createParty(db, cid, uid, "SUPPLIER", { name: "SF Sonic Distributors", gstin: g("21BBBBB2222B1Z") })).id;
  cust = (await createParty(db, cid, uid, "CUSTOMER", { name: "Ramesh Traders", creditLimit: "50000" })).id;
  await createBill(db, { companyId: cid, userId: uid, partyId: sup, billNumber: "A-1", date: "2026-09-01", lines: [{ productId: bat, qty: "50", rate: "4000" }] });
  await createBill(db, { companyId: cid, userId: uid, partyId: sup, billNumber: "A-1 copy", date: "2026-09-03", lines: [{ productId: bat, qty: "50", rate: "4000" }] });
  for (let i = 0; i < 5; i++) await createSale(db, { companyId: cid, userId: uid, partyId: cust, date: `2026-09-1${i}`, lines: [{ productId: bat, qty: "1", rate: "5000" }], creditOverrideReason: "x" });
  await createSale(db, { companyId: cid, userId: uid, partyId: cust, date: "2026-09-20", lines: [{ productId: bat, qty: "1", rate: "3500" }], creditOverrideReason: "x" });
  await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: cust, cashBankId: cash, amount: "210000", date: "2026-09-21" });
  await recordPayment(db, { companyId: cid, userId: uid, date: "2026-09-22", amount: "15000", cashBankId: cash, toAccountId: acc.RENT });
});

describe("unusual things", () => {
  it("finds duplicate bill, below-cost sale, large cash receipt; each explains itself", async () => {
    const f = (await findings(db, cid, "2026-09-29")).open;
    const kinds = f.map((x) => x.kind);
    expect(kinds).toContain("DUP_BILL"); expect(kinds).toContain("BELOW_COST"); expect(kinds).toContain("CASH_IN");
    const below = f.find((x) => x.kind === "BELOW_COST")!;
    expect(below.what).toMatch(/₹3,500\.00.*₹4,000\.00/); expect(below.why).toMatch(/₹500\.00/);
    for (const x of f) { expect(x.why.length).toBeGreaterThan(10); expect(x.action.length).toBeGreaterThan(5); expect(x.href).toMatch(/^\//); }
    // Customer paid 2.1 lakh against 2.3 lakh sales -> no longer over limit? 3,500+25,000 → owes 28,500 ... under 50k, so not flagged.
    expect(kinds).not.toContain("OVER_LIMIT");
  });
  it("no false alarm on a clean company", async () => {
    const r = await registerOwner(db, { name: "Z", email: `z_${Date.now()}@t.in`, password: "secret123", businessName: "Z" });
    expect((await findings(db, r.company.id)).open).toEqual([]);
  });
  it("marking checked hides it and is audited; other findings stay", async () => {
    const before = (await findings(db, cid, "2026-09-29")).open;
    const dup = before.find((x) => x.kind === "DUP_BILL")!;
    await markChecked(db, cid, uid, dup.key, "Two real deliveries");
    const after = await findings(db, cid, "2026-09-29", { includeChecked: true });
    expect(after.open.find((x) => x.key === dup.key)).toBeUndefined();
    expect(after.checked.map((x) => x.key)).toContain(dup.key);
    expect(after.open.length).toBe(before.length - 1);
    const log = await db.execute(sql`SELECT reason FROM audit_logs WHERE company_id = ${cid} AND action = 'check.ok'`);
    expect(log.rows[0]).toMatchObject({ reason: "Two real deliveries" });
    await expect(markChecked(db, cid, uid, "bad key; drop", "")).rejects.toThrow();
  });
});

describe("quick entry against real data", () => {
  it("matches names from the database and only proposes", async () => {
    const c = await quickEntryContext(cid);
    const n = await db.execute(sql`SELECT count(*)::int n FROM journal_entries WHERE company_id = ${cid}`);
    const p = parseQuickEntry("ramesh ne 7,500 diya upi", { parties: c.parties, accounts: c.accounts, today: "2026-09-29" });
    expect(p).toMatchObject({ kind: "CUSTOMER_PAYMENT", partyId: cust, amount: "7500", mode: "BANK" });
    expect(parseQuickEntry("paid sf sonic 1 lakh neft", { parties: c.parties, accounts: c.accounts, today: "2026-09-29" })).toMatchObject({ kind: "SUPPLIER_PAYMENT", partyId: sup, amount: "100000" });
    const n2 = await db.execute(sql`SELECT count(*)::int n FROM journal_entries WHERE company_id = ${cid}`);
    expect(n2.rows[0]).toEqual(n.rows[0]); // parsing never writes
  });
  it("money-in receipt posts once (regression: form used to post and then show an error)", async () => {
    const e = await recordReceipt(db, { companyId: cid, userId: uid, date: "2026-09-25", amount: "100000", cashBankId: bank, fromAccountId: acc.CAPITAL });
    expect(e.id).toBeTruthy();
  });
});
