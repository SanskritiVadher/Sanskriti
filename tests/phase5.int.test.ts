import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, updateBusinessInfo, updateGstInfo } from "@/lib/services/company";
import { createParty, partyBalances } from "@/lib/services/parties";
import { createProduct, stockOf, inventoryReconciliation } from "@/lib/services/inventory";
import { createSale, cancelSale } from "@/lib/services/sales";
import { createBill } from "@/lib/services/purchases";
import { createCreditNote, createDebitNote, returnableLines } from "@/lib/services/notes";
import { openItems } from "@/lib/services/receivables";
import { parsePeriod, gstr1, gstr1Json, gstr3b, setOff, parse2b, import2b, reconcile2b, gstReview, addRule, confirmRule, applyRuleToProducts, ruleFor, gstLedgerPosition, recordGstPayment, gstReconciliation } from "@/lib/services/gst";
import { trialBalance, ledgerHealth, naturalBalance } from "@/lib/accounting/reports";
import { gstinCheckChar } from "@/lib/gst/gstin";
import { D } from "@/lib/money";

afterAll(async () => { await pool.end(); });
const g = (b: string) => b + gstinCheckChar(b);
let cid = "", uid = "", bank = "", bat = "", fan = "", regCust = "", smallCust = "", biharCust = "", sup = "", interSup = "";
const acc: Record<string, string> = {};
const bal = async (k: string) => { const t = await trialBalance(db, cid, "2027-03-31"); const r = t.rows.find((x) => x.accountId === acc[k])!; return naturalBalance(r.nature, r.totalDebit, r.totalCredit).toFixed(2); };
const SUP_GSTIN = g("21BBBBB2222B1Z"), INTER_GSTIN = g("19DDDDD4444D1Z");

beforeAll(async () => {
  const r = await registerOwner(db, { name: "G", email: `gst_${Date.now()}@t.in`, password: "secret123", businessName: "GST Co" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "GST Co", stateCode: "21" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  for (const a of await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })) if (a.systemKey) acc[a.systemKey] = a.id;
  bat = (await createProduct(db, cid, uid, { name: "Battery 35Ah", hsn: "85071000", gstRate: "18", gstConfirmed: true })).id;
  fan = (await createProduct(db, cid, uid, { name: "Ceiling Fan", hsn: "84145110", gstRate: "18", gstConfirmed: true })).id;
  regCust = (await createParty(db, cid, uid, "CUSTOMER", { name: "Ravi Traders", gstin: g("21CCCCC3333C1Z") })).id;
  smallCust = (await createParty(db, cid, uid, "CUSTOMER", { name: "Walk-in", stateCode: "21" })).id;
  biharCust = (await createParty(db, cid, uid, "CUSTOMER", { name: "Patna Shop", stateCode: "10" })).id;
  sup = (await createParty(db, cid, uid, "SUPPLIER", { name: "SF Distributors", gstin: SUP_GSTIN })).id;
  interSup = (await createParty(db, cid, uid, "SUPPLIER", { name: "Kolkata Depot", gstin: INTER_GSTIN })).id;
  await createBill(db, { companyId: cid, userId: uid, partyId: sup, billNumber: "SFD/0101", date: "2026-09-02", lines: [{ productId: bat, qty: "50", rate: "4500" }] });
  await createBill(db, { companyId: cid, userId: uid, partyId: interSup, billNumber: "KD-77", date: "2026-09-03", lines: [{ productId: fan, qty: "20", rate: "1800" }] });
});

describe("periods", () => {
  it("parses months and Indian FY quarters", () => {
    expect(parsePeriod("2026-09")).toMatchObject({ from: "2026-09-01", to: "2026-09-30", fp: "092026" });
    expect(parsePeriod("2026-Q2")).toMatchObject({ from: "2026-07-01", to: "2026-09-30", fp: "092026" });
    expect(parsePeriod("2026-Q4")).toMatchObject({ from: "2027-01-01", to: "2027-03-31", fp: "032027" });
  });
});

describe("credit note (customer return)", () => {
  it("partial return reverses exactly that share of sales, GST, dues, stock and COGS", async () => {
    const { invoice } = await createSale(db, { companyId: cid, userId: uid, partyId: regCust, date: "2026-09-05", lines: [{ productId: bat, qty: "10", rate: "5000", discountPct: "2" }] });
    const before = { stock: await stockOf(db, bat), cogs: await bal("COGS"), out: await bal("OUTPUT_CGST") };
    const [line] = await returnableLines(db, "CREDIT_NOTE", invoice.id);
    const cn = await createCreditNote(db, { companyId: cid, userId: uid, invoiceId: invoice.id, date: "2026-09-10", reason: "2 batteries faulty", lines: [{ sourceLineId: line.id, qty: "2" }] });
    // 2 × 5000 × 0.98 = 9,800 taxable; GST 882 each head? 9,800 × 9% = 882
    expect([cn.taxable, cn.cgst, cn.sgst, cn.total]).toEqual(["9800.00", "882.00", "882.00", "11564.00"]);
    expect(cn.number).toMatch(/^CN\//);
    expect((await stockOf(db, bat)).qty.minus(before.stock.qty).toString()).toBe("2");
    expect(D(before.cogs).minus(await bal("COGS")).toFixed(2)).toBe("9000.00"); // 2 × 4,500 cost back
    expect(D(before.out).minus(await bal("OUTPUT_CGST")).toFixed(2)).toBe("882.00");
    expect(await bal("SALES_RETURNS")).toBe("-9800.00"); // contra-income (debit balance on an income account)
    // return is applied to its own invoice
    const oi = (await openItems(db, cid, regCust, "2026-09-10"))!;
    expect(oi.open[0].open.toFixed(2)).toBe(D(invoice.total).minus("11564.00").toFixed(2));
    await expect(createCreditNote(db, { companyId: cid, userId: uid, invoiceId: invoice.id, date: "2026-09-11", reason: "x", lines: [{ sourceLineId: line.id, qty: "9" }] })).rejects.toThrow(/only 8 can still be returned/);
    await expect(createCreditNote(db, { companyId: cid, userId: uid, invoiceId: invoice.id, date: "2026-09-01", reason: "x", lines: [{ sourceLineId: line.id, qty: "1" }] })).rejects.toThrow(/before the invoice/);
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
    await expect(cancelSale(db, { companyId: cid, userId: uid, invoiceId: invoice.id, reason: "x" })).rejects.toThrow(/already returned/);
  });
});

describe("debit note (return to supplier)", () => {
  it("reduces what we owe, reverses input GST, takes stock out at purchase cost", async () => {
    const b = await db.query.purchaseBills.findFirst({ where: eq(schema.purchaseBills.billNumber, "SFD/0101") });
    const [line] = await returnableLines(db, "DEBIT_NOTE", b!.id);
    const owedBefore = (await partyBalances(db, cid, "SUPPLIER")).get(sup)!.balance;
    const inBefore = await bal("INPUT_CGST");
    const dn = await createDebitNote(db, { companyId: cid, userId: uid, billId: b!.id, date: "2026-09-12", reason: "Damaged in transit", lines: [{ sourceLineId: line.id, qty: "3" }] });
    expect([dn.taxable, dn.cgst, dn.total]).toEqual(["13500.00", "1215.00", "15930.00"]);
    expect(owedBefore.minus((await partyBalances(db, cid, "SUPPLIER")).get(sup)!.balance).toFixed(2)).toBe("15930.00");
    expect(D(inBefore).minus(await bal("INPUT_CGST")).toFixed(2)).toBe("1215.00");
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
    expect((await trialBalance(db, cid, "2027-03-31")).balanced).toBe(true);
  });
});

describe("GSTR-1", () => {
  it("classifies B2B, B2CL (>₹1 lakh inter-state unregistered), B2CS, CDNR; HSN split; totals reconcile", async () => {
    await createSale(db, { companyId: cid, userId: uid, partyId: smallCust, date: "2026-09-15", lines: [{ productId: fan, qty: "2", rate: "2200" }] });           // B2CS intra
    await createSale(db, { companyId: cid, userId: uid, partyId: biharCust, date: "2026-09-16", lines: [{ productId: bat, qty: "2", rate: "5000" }] });           // B2CS inter (11,800 ≤ 1L)
    await createSale(db, { companyId: cid, userId: uid, partyId: biharCust, date: "2026-09-17", lines: [{ productId: bat, qty: "20", rate: "5000" }] });          // B2CL (1,18,000 > 1L)
    const c = await createSale(db, { companyId: cid, userId: uid, partyId: smallCust, date: "2026-09-18", lines: [{ productId: fan, qty: "1", rate: "2200" }] });
    await cancelSale(db, { companyId: cid, userId: uid, invoiceId: c.invoice.id, reason: "test" });                                                                // cancelled: excluded, counted in docs
    const r = await gstr1(db, cid, parsePeriod("2026-09"));
    expect(r.b2b).toHaveLength(1); expect(r.b2cl).toHaveLength(1); expect(r.cdnr).toHaveLength(1);
    expect(r.b2cs.map((x) => `${x.type}:${x.pos}:${x.taxable.toFixed(2)}`).sort()).toEqual(["INTER:10:10000.00", "INTRA:21:4400.00"]);
    expect(r.docIssue[0]).toMatchObject({ total: 5, cancelled: 1 });
    expect(r.hsnB2B.map((h) => [h.hsn, h.qty.toString(), h.taxable.toFixed(2)])).toEqual([["85071000", "8", "39200.00"]]); // 10 − 2 returned
    expect(r.hsnB2C.reduce((s, h) => s.plus(h.taxable), D(0)).toFixed(2)).toBe("114400.00");
    // Totals: B2B + B2CL + B2CS − CDNR = net outward taxable = sales − returns in the ledger
    const t = r.totals;
    const net = t.b2b.taxable.plus(t.b2cl.taxable).plus(t.b2cs.taxable).minus(t.cdnr.taxable);
    expect(net.toFixed(2)).toBe(D(await bal("SALES")).plus(await bal("SALES_RETURNS")).toFixed(2));
    const j = gstr1Json(r) as Record<string, unknown>;
    expect(j.fp).toBe("092026"); expect(j.gstin).toMatch(/^21AAAAA1111A1Z/);
    const b2b = j.b2b as { ctin: string; inv: { idt: string; itms: { itm_det: { camt: number } }[] }[] }[];
    expect(b2b[0].inv[0].idt).toBe("05-09-2026"); expect(b2b[0].inv[0].itms[0].itm_det.camt).toBe(4410);
    expect((j.hsn as Record<string, unknown>).hsn_b2b).toBeTruthy(); expect((j.hsn as Record<string, unknown>).hsn_b2c).toBeTruthy();
  });
});

describe("set-off order (Sec 49 / Rule 88A)", () => {
  it("uses IGST credit first, never CGST credit for SGST", () => {
    const r = setOff({ igst: D(1000), cgst: D(5000), sgst: D(5000) }, { igst: D(3000), cgst: D(1000), sgst: D(8000) });
    expect(r.used.igst.igst.toFixed(0)).toBe("1000"); expect(r.used.igst.cgst.toFixed(0)).toBe("2000");
    expect(r.used.cgst.cgst.toFixed(0)).toBe("1000"); expect(r.used.sgst.sgst.toFixed(0)).toBe("5000");
    expect(r.cash.cgst.toFixed(0)).toBe("2000");          // CGST short, SGST credit cannot cover it
    expect(r.carryForward.sgst.toFixed(0)).toBe("3000");
    expect(r.cashTotal.toFixed(0)).toBe("2000");
  });
});

describe("GSTR-3B + payment", () => {
  it("3B equals GSTR-1 net of returns and bills net of debit notes; payment clears ledger by legal set-off", async () => {
    const r = await gstr3b(db, cid, parsePeriod("2026-09"));
    expect(r.out.taxable.toFixed(2)).toBe("153600.00"); // 49,000 − 9,800 + 4,400 + 10,000 + 1,00,000
    expect(r.inp.cgst.toFixed(2)).toBe("19035.00");     // 20,250 − 1,215
    expect(r.inp.igst.toFixed(2)).toBe("6480.00");      // 36,000 × 18%
    expect(r.interUnreg.find((x) => x.pos === "10")!.taxable.toFixed(2)).toBe("110000.00");
    const pos = await gstLedgerPosition(db, cid, "2026-09-30");
    expect(pos.liab.igst.toFixed(2)).toBe(r.out.igst.toFixed(2));
    const { cash } = await recordGstPayment(db, { companyId: cid, userId: uid, asOf: "2026-09-30", paidOn: "2026-10-20", bankId: bank, reference: "CPIN123" });
    expect(cash.toFixed(2)).toBe(pos.setoff.cashTotal.toFixed(2));
    const after = await gstLedgerPosition(db, cid, "2026-10-20");
    expect(after.liab.igst.plus(after.liab.cgst).plus(after.liab.sgst).toFixed(2)).toBe("0.00");
    expect(after.credit.cgst.toFixed(2)).toBe(pos.setoff.carryForward.cgst.toFixed(2));
    expect((await gstReconciliation(db, cid)).ok).toBe(true);
    await expect(recordGstPayment(db, { companyId: cid, userId: uid, asOf: "2026-09-30", paidOn: "2026-10-21", bankId: bank })).rejects.toThrow(/Nothing to settle|no GST payable/);
  });
});

describe("GSTR-2B matching", () => {
  it("matches by GSTIN + bill number ignoring punctuation; flags differences and missing", async () => {
    const json = { data: { gstin: "x", rtnprd: "092026", docdata: { b2b: [
      { ctin: SUP_GSTIN, trdnm: "SF Distributors", inv: [{ inum: "SFD-101", dt: "02-09-2026", val: 265500, itcavl: "Y", items: [{ num: 1, rt: 18, txval: 225000, cgst: 20250, sgst: 20250, igst: 0 }] }] },
      { ctin: INTER_GSTIN, trdnm: "Kolkata Depot", inv: [{ inum: "KD-77", dt: "03-09-2026", val: 42000, items: [{ txval: 36000, igst: 6000 }] }] },
      { ctin: g("21EEEEE5555E1Z"), trdnm: "Unknown Seller", inv: [{ inum: "Z1", dt: "04-09-2026", val: 1180, items: [{ txval: 1000, cgst: 90, sgst: 90 }] }] },
    ] } } };
    expect(parse2b(json)).toHaveLength(3);
    const imp = await import2b(db, cid, uid, "2026-09", "2b.json", JSON.stringify(json));
    const r = (await reconcile2b(db, cid, imp.id))!;
    const by = (n: string) => r.rows.find((x) => x.number.replace(/\W/g, "") === n.replace(/\W/g, ""))!;
    expect(by("SFD/0101").status).toBe("MATCHED");   // "SFD/0101" vs "SFD-101"
    expect(by("KD-77").status).toBe("AMOUNT_DIFF");   // 6,480 in books vs 6,000 in 2B
    expect(by("Z1").status).toBe("NOT_IN_BOOKS");
    expect(r.counts).toMatchObject({ matched: 1, diff: 1, notInBooks: 1, notIn2b: 0 });
    expect(() => parse2b({ foo: 1 })).toThrow(/doesn't look like/);
  });
});

describe("rate table", () => {
  it("never applies an unconfirmed rate; picks most specific HSN; flags mismatches", async () => {
    const r1 = await addRule(db, cid, uid, { hsnPrefix: "8507", description: "Batteries", rate: "18", effectiveFrom: "2025-09-22", status: "SECONDARY_SOURCE", sourceName: "Tally guide" });
    await expect(applyRuleToProducts(db, cid, uid, r1.id)).rejects.toThrow(/Confirm this rate first/);
    await expect(confirmRule(db, cid, uid, r1.id, "VERIFIED")).rejects.toThrow(/official notification link/);
    await confirmRule(db, cid, uid, r1.id, "USER_CONFIRMED");
    expect(await applyRuleToProducts(db, cid, uid, r1.id)).toBe(1);
    const r2 = await addRule(db, cid, uid, { hsnPrefix: "84145110", description: "Ceiling fans (test)", rate: "12", effectiveFrom: "2025-01-01", status: "UNVERIFIED" });
    const rules = await db.query.gstRateRules.findMany({ where: eq(schema.gstRateRules.companyId, cid) });
    expect(ruleFor(rules, "84145110", "2026-09-30")!.id).toBe(r2.id);
    expect(ruleFor(rules, "85071000", "2025-01-01")).toBeNull(); // before effective date
    const rev = await gstReview(db, cid, parsePeriod("2026-09"));
    expect(rev.map((x) => x.what).join(" ")).toMatch(/differ from an unchecked rate in your table: Ceiling Fan/);
    expect(rev.map((x) => x.what).join(" ")).toMatch(/inter-state bill\(s\) over ₹1 lakh/);
  });
});

describe("whole system after Phase 5", () => {
  it("all health checks pass (incl. GST books vs documents)", async () => {
    for (const c of await ledgerHealth(db, cid)) expect([c.name, c.ok]).toEqual([c.name, true]);
  });
});
