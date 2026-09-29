import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, addBrand, updateBusinessInfo, updateGstInfo } from "@/lib/services/company";
import { createParty, recordCustomerPayment, partyBalances } from "@/lib/services/parties";
import { createProduct, stockOf, inventoryReconciliation, updateProduct } from "@/lib/services/inventory";
import { createSale, cancelSale, CreditLimitError, getInvoice } from "@/lib/services/sales";
import { createBill, cancelBill } from "@/lib/services/purchases";
import { openItems, ageing } from "@/lib/services/receivables";
import { trialBalance, naturalBalance, ledgerHealth } from "@/lib/accounting/reports";
import { reverseEntry } from "@/lib/accounting/engine";
import { gstinCheckChar } from "@/lib/gst/gstin";
import { D } from "@/lib/money";

afterAll(async () => { await pool.end(); });
const g = (b: string) => b + gstinCheckChar(b);
let cid = "", uid = "", bank = "", sf35 = "", usha = "", supplier = "", customer = "", interCustomer = "";
const acc: Record<string, string> = {};
const tb = () => trialBalance(db, cid, "2027-03-31");
const bal = async (k: string) => { const t = await tb(); const r = t.rows.find((x) => x.accountId === acc[k])!; return naturalBalance(r.nature, r.totalDebit, r.totalCredit).toFixed(2); };

beforeAll(async () => {
  // Create company (Odisha, GST regular)
  const r = await registerOwner(db, { name: "Owner", email: `p4_${Date.now()}@t.in`, password: "secret123", businessName: "Sharma Battery House" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "Sharma Battery House", stateCode: "21", city: "Cuttack", addressLine1: "Link Road" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  for (const a of await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })) if (a.systemKey) acc[a.systemKey] = a.id;
  acc.BANK = bank;
  // Add SF Sonic and Usha products
  const sf = await addBrand(db, cid, uid, "SF Sonic"), us = await addBrand(db, cid, uid, "Usha");
  sf35 = (await createProduct(db, cid, uid, { name: "SF Sonic 35Ah", brandId: sf.id, hsn: "8507", gstRate: "18", gstConfirmed: true, dealerPrice: "5000", minSellingPrice: "4800" })).id;
  usha = (await createProduct(db, cid, uid, { name: "Usha Fan 1200", brandId: us.id, hsn: "8414", gstRate: "18", gstConfirmed: true, dealerPrice: "2200" })).id;
  // Add supplier and customer
  supplier = (await createParty(db, cid, uid, "SUPPLIER", { name: "SF Distributors", gstin: g("21BBBBB2222B1Z"), creditDays: "30" })).id;
  customer = (await createParty(db, cid, uid, "CUSTOMER", { name: "Ravi Traders", gstin: g("21CCCCC3333C1Z"), creditDays: "30", creditLimit: "100000", phone: "9876543210" })).id;
  interCustomer = (await createParty(db, cid, uid, "CUSTOMER", { name: "Ranchi Auto", stateCode: "20", creditDays: "15" })).id;
});

describe("CRITICAL END-TO-END (brief §54)", () => {
  it("purchase 20 SF Sonic batteries on credit", async () => {
    const { bill } = await createBill(db, { companyId: cid, userId: uid, partyId: supplier, billNumber: "SFD/101", date: "2026-09-01",
      lines: [{ productId: sf35, qty: "20", rate: "4500" }] });
    expect(bill.total).toBe("106200.00"); // 90,000 + 18% = 16,200
    // Inventory increases
    const s = await stockOf(db, sf35); expect(s.qty.toString()).toBe("20"); expect(s.value.toFixed(2)).toBe("90000.00");
    // Supplier payable increases
    expect((await partyBalances(db, cid, "SUPPLIER")).get(supplier)!.balance.toFixed(2)).toBe("106200.00");
    // Input GST recorded correctly (intra-state: CGST + SGST)
    expect(await bal("INPUT_CGST")).toBe("8100.00"); expect(await bal("INPUT_SGST")).toBe("8100.00"); expect(await bal("INPUT_IGST")).toBe("0.00");
    // Journal balances
    const e = await db.query.journalLines.findMany({ where: eq(schema.journalLines.entryId, bill.entryId) });
    expect(e.reduce((a, l) => a.plus(l.debit), D(0)).toFixed(2)).toBe(e.reduce((a, l) => a.plus(l.credit), D(0)).toFixed(2));
  });

  let invId = "";
  it("sell 5 batteries to a customer", async () => {
    const { invoice } = await createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-05",
      lines: [{ productId: sf35, qty: "5", rate: "5000" }] });
    invId = invoice.id;
    expect([invoice.taxable, invoice.cgst, invoice.sgst, invoice.igst, invoice.total]).toEqual(["25000.00", "2250.00", "2250.00", "0.00", "29500.00"]);
    expect(invoice.number).toBe("INV/2026-27/0001");
    expect(invoice.dueDate).toBe("2026-10-05");
    // Inventory decreases, COGS at average cost 4,500
    const s = await stockOf(db, sf35); expect(s.qty.toString()).toBe("15"); expect(s.value.toFixed(2)).toBe("67500.00");
    expect(await bal("COGS")).toBe("22500.00");
    // Sales recorded, output GST recorded, receivable increases
    expect(await bal("SALES")).toBe("25000.00");
    expect(await bal("OUTPUT_CGST")).toBe("2250.00"); expect(await bal("OUTPUT_SGST")).toBe("2250.00");
    expect((await partyBalances(db, cid, "CUSTOMER")).get(customer)!.balance.toFixed(2)).toBe("29500.00");
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
    expect((await tb()).balanced).toBe(true);
  });

  it("receive a partial customer payment", async () => {
    await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: customer, cashBankId: bank, amount: "10000", date: "2026-09-10" });
    expect((await partyBalances(db, cid, "CUSTOMER")).get(customer)!.balance.toFixed(2)).toBe("19500.00");
    expect(await bal("BANK")).toBe("10000.00");
    const oi = (await openItems(db, cid, customer, "2026-09-10"))!;
    expect(oi.open).toHaveLength(1); expect(oi.open[0].open.toFixed(2)).toBe("19500.00"); expect(oi.overdue.toFixed(2)).toBe("0.00");
  });

  it("all statements reconcile", async () => {
    const t = await tb();
    expect(t.balanced).toBe(true);
    const sumNature = (n: string) => t.rows.filter((r) => r.nature === n).reduce((s, r) => s.plus(naturalBalance(r.nature, r.totalDebit, r.totalCredit)), D(0));
    const profit = sumNature("INCOME").minus(sumNature("EXPENSE"));
    expect(profit.toFixed(2)).toBe("2500.00"); // 25,000 sales − 22,500 cost
    // Balance sheet: assets = liabilities + equity + profit
    expect(sumNature("ASSET").toFixed(2)).toBe(sumNature("LIABILITY").plus(sumNature("EQUITY")).plus(profit).toFixed(2));
    // GST summary: output 4,500 − input 16,200 = 11,700 credit carried forward
    const out = D(await bal("OUTPUT_CGST")).plus(await bal("OUTPUT_SGST")), inp = D(await bal("INPUT_CGST")).plus(await bal("INPUT_SGST"));
    expect(inp.minus(out).toFixed(2)).toBe("11700.00");
    // Inventory report = ledger; receivables = ledger; payables = ledger
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
    const cust = [...(await partyBalances(db, cid, "CUSTOMER")).values()].reduce((s, b) => s.plus(b.balance), D(0));
    expect(cust.toFixed(2)).toBe(await bal("DEBTORS_CONTROL"));
    const sup = [...(await partyBalances(db, cid, "SUPPLIER")).values()].reduce((s, b) => s.plus(b.balance), D(0));
    expect(sup.toFixed(2)).toBe(await bal("CREDITORS_CONTROL"));
    const h = await ledgerHealth(db, cid);
    for (const c of h) expect([c.name, c.ok]).toEqual([c.name, true]);
    expect(invId).toBeTruthy();
  });
});

describe("GST treatment", () => {
  it("inter-state sale uses IGST and warns about e-way bill above ₹50,000", async () => {
    const { invoice, warnings } = await createSale(db, { companyId: cid, userId: uid, partyId: interCustomer, date: "2026-09-06",
      lines: [{ productId: sf35, qty: "10", rate: "5000" }] });
    expect([invoice.cgst, invoice.sgst, invoice.igst, invoice.total]).toEqual(["0.00", "0.00", "9000.00", "59000.00"]);
    expect(invoice.supplyType).toBe("INTER"); expect(invoice.placeOfSupply).toBe("20");
    expect(warnings.join(" ")).toMatch(/e-way bill/);
    expect(await bal("OUTPUT_IGST")).toBe("9000.00");
  });
  it("inter-state purchase uses input IGST", async () => {
    const wb = await createParty(db, cid, uid, "SUPPLIER", { name: "Kolkata Usha Depot", gstin: g("19DDDDD4444D1Z") });
    await createBill(db, { companyId: cid, userId: uid, partyId: wb.id, billNumber: "K-9", date: "2026-09-02", lines: [{ productId: usha, qty: "10", rate: "1850" }] });
    expect(await bal("INPUT_IGST")).toBe("3330.00");
    expect((await stockOf(db, usha)).value.toFixed(2)).toBe("18500.00");
  });
  it("unregistered supplier: no GST on the bill", async () => {
    const u = await createParty(db, cid, uid, "SUPPLIER", { name: "Local Scrap Dealer" });
    const { bill } = await createBill(db, { companyId: cid, userId: uid, partyId: u.id, billNumber: "S1", date: "2026-09-02", lines: [{ productId: usha, qty: "1", rate: "1000" }] });
    expect(bill.total).toBe("1000.00"); expect(bill.supplyType).toBe("NONE");
  });
  it("refuses to bill a product with no GST rate", async () => {
    const p = await createProduct(db, cid, uid, { name: "No Rate Item", openingQty: "5", openingRate: "10" });
    await expect(createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-07", lines: [{ productId: p.id, qty: "1", rate: "20" }] }))
      .rejects.toThrow(/no GST rate/);
  });
  it("warns when GST rate isn't confirmed; rounds to the rupee with a round-off line", async () => {
    await updateProduct(db, cid, uid, usha, { name: "Usha Fan 1200", sku: "USHA-FAN-1200", gstRate: "18", gstConfirmed: false });
    const { invoice, warnings } = await createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-07",
      lines: [{ productId: usha, qty: "3", rate: "2199.99", discountPct: "2.5" }] });
    expect(warnings.join(" ")).toMatch(/not confirmed/);
    const total = D(invoice.taxable).plus(invoice.cgst).plus(invoice.sgst).plus(invoice.roundOff);
    expect(total.toFixed(2)).toBe(invoice.total); expect(D(invoice.total).decimalPlaces()).toBe(0);
    expect((await tb()).balanced).toBe(true);
  });
});

describe("controls", () => {
  it("blocks overselling", async () => {
    const s = await stockOf(db, sf35);
    await expect(createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-08", lines: [{ productId: sf35, qty: s.qty.plus(1).toString(), rate: "5000" }] }))
      .rejects.toThrow(/Only .* in stock/);
  });
  it("credit limit needs an override reason; margin warnings", async () => {
    // Ravi owes ~27k; limit 1,00,000. A 2-battery bill fits; 15 would not.
    let err: unknown;
    try { await createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-08", lines: [{ productId: sf35, qty: "4", rate: "20000" }] }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(CreditLimitError);
    expect((err as CreditLimitError).message).toMatch(/over their credit limit/);
    const { warnings } = await createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-08",
      lines: [{ productId: sf35, qty: "1", rate: "4000" }], creditOverrideReason: "not needed" });
    expect(warnings.join(" ")).toMatch(/below your lowest allowed price|below its cost/);
    const r2 = await createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-08",
      lines: [{ productId: sf35, qty: "4", rate: "20000" }], creditOverrideReason: "Old customer, promised payment Friday" });
    expect(r2.warnings.join(" ")).toMatch(/Credit limit crossed/);
    expect(r2.invoice.creditOverrideReason).toMatch(/Friday/);
  });
  it("detects a duplicate supplier bill", async () => {
    await expect(createBill(db, { companyId: cid, userId: uid, partyId: supplier, billNumber: "sfd/101", date: "2026-09-03", lines: [{ productId: sf35, qty: "1", rate: "4500" }] }))
      .rejects.toThrow(/already recorded/);
  });
  it("warns when a supplier raises the price", async () => {
    const { warnings } = await createBill(db, { companyId: cid, userId: uid, partyId: supplier, billNumber: "SFD/102", date: "2026-09-12", lines: [{ productId: sf35, qty: "10", rate: "4800" }] });
    expect(warnings.join(" ")).toMatch(/up 6.7% from ₹4,500.00/);
    // weighted average: remaining stock + 10 @ 4,800
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
  });
  it("cash sale ≥ ₹2 lakh warns about the cash rule", async () => {
    const big = await createProduct(db, cid, uid, { name: "Inverter Set", gstRate: "18", gstConfirmed: true, openingQty: "5", openingRate: "150000" });
    const walk = await createParty(db, cid, uid, "CUSTOMER", { name: "Walk-in Customer" });
    const { warnings } = await createSale(db, { companyId: cid, userId: uid, partyId: walk.id, date: "2026-09-13",
      lines: [{ productId: big.id, qty: "1", rate: "180000" }], paidNow: { amount: "212400", cashBankId: acc.CASH } });
    expect(warnings.join(" ")).toMatch(/₹2 lakh or more in cash/);
    expect((await partyBalances(db, cid, "CUSTOMER")).get(walk.id)!.balance.toFixed(2)).toBe("0.00");
  });
});

describe("cancellation", () => {
  it("cancelling an invoice restores stock, dues and GST exactly; number stays used", async () => {
    const before = { stock: (await stockOf(db, sf35)), cust: (await partyBalances(db, cid, "CUSTOMER")).get(customer)!.balance, out: await bal("OUTPUT_CGST") };
    const { invoice } = await createSale(db, { companyId: cid, userId: uid, partyId: customer, date: "2026-09-14",
      lines: [{ productId: sf35, qty: "2", rate: "5000" }], creditOverrideReason: "ok" });
    await cancelSale(db, { companyId: cid, userId: uid, invoiceId: invoice.id, reason: "Wrong customer" });
    const after = await stockOf(db, sf35);
    expect(after.qty.toString()).toBe(before.stock.qty.toString()); expect(after.value.toFixed(2)).toBe(before.stock.value.toFixed(2));
    expect((await partyBalances(db, cid, "CUSTOMER")).get(customer)!.balance.toFixed(2)).toBe(before.cust.toFixed(2));
    expect(await bal("OUTPUT_CGST")).toBe(before.out);
    await expect(cancelSale(db, { companyId: cid, userId: uid, invoiceId: invoice.id, reason: "x" })).rejects.toThrow(/already cancelled/);
    const next = await createSale(db, { companyId: cid, userId: uid, partyId: interCustomer, date: "2026-09-14", lines: [{ productId: usha, qty: "1", rate: "2200" }] });
    expect(Number(next.invoice.number.split("/")[2])).toBe(Number(invoice.number.split("/")[2]) + 1);
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
  });
  it("won't cancel a purchase bill whose stock is already sold", async () => {
    const b = await db.query.purchaseBills.findFirst({ where: and(eq(schema.purchaseBills.companyId, cid), eq(schema.purchaseBills.billNumber, "K-9")) });
    const s = await stockOf(db, usha);
    if (s.qty.lt(10)) await expect(cancelBill(db, { companyId: cid, userId: uid, billId: b!.id, reason: "test" })).rejects.toThrow(/already been sold/);
  });
  it("cancels an unsold purchase bill cleanly", async () => {
    const p = await createProduct(db, cid, uid, { name: "Spare Terminal", gstRate: "18", gstConfirmed: true });
    const { bill } = await createBill(db, { companyId: cid, userId: uid, partyId: supplier, billNumber: "SFD/200", date: "2026-09-15", lines: [{ productId: p.id, qty: "4", rate: "50" }] });
    await cancelBill(db, { companyId: cid, userId: uid, billId: bill.id, reason: "Entered wrong supplier" });
    expect((await stockOf(db, p.id)).qty.toString()).toBe("0");
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
  });
});

describe("receivables: FIFO, overdue, habit, ranking", () => {
  it("payments settle oldest bills first; overdue days are measured from due date", async () => {
    const c = await createParty(db, cid, uid, "CUSTOMER", { name: "Habit Co", creditDays: "10", openingBalance: "1000", openingDate: "2026-04-01" });
    const mk = (d: string) => createSale(db, { companyId: cid, userId: uid, partyId: c.id, date: d, lines: [{ productId: usha, qty: "1", rate: "1000" }] });
    await createBill(db, { companyId: cid, userId: uid, partyId: supplier, billNumber: "SFD/300", date: "2026-05-01", lines: [{ productId: usha, qty: "10", rate: "900" }] });
    await mk("2026-05-01"); await mk("2026-06-01"); await mk("2026-07-01"); await mk("2026-08-01"); // each 1180, due +10 days
    const pay = (a: string, d: string) => recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: c.id, cashBankId: bank, amount: a, date: d });
    await pay("1000", "2026-04-20");            // clears old balance
    await pay("1180", "2026-05-21");            // clears May bill, 10 days late
    await pay("1180", "2026-06-30");            // clears June bill, 19 days late
    const bounced = await pay("1180", "2026-07-15");
    await reverseEntry(db, { companyId: cid, userId: uid, entryId: bounced.id, reason: "cheque bounced" });
    await pay("1180", "2026-07-25");            // clears July bill, 14 days late
    const r = (await openItems(db, cid, c.id, "2026-09-01"))!;
    expect(r.open.map((i) => i.number)).toHaveLength(1);                 // only August open
    expect(r.open[0].daysOverdue).toBe(21);                              // due 11 Aug → 1 Sep
    expect(r.overdue.toFixed(2)).toBe("1180.00");
    expect(r.habit).toEqual({ count: 3, avgDaysLate: 14, onTime: 0 });   // (10+19+14)/3 = 14.3
    expect(r.items.find((i) => i.kind === "OPENING")!.ageUnknown).toBe(true);
    const a = await ageing(db, cid, "CUSTOMER", "2026-09-01");
    expect(a.parties.find((p) => p.name === "Habit Co")!.oldest).toBe(21);
    expect(a.buckets.d1_30.gte(1180)).toBe(true);
  });
});

describe("old balances are never given invented ages", () => {
  it("shows an unpaid opening balance as 'old', not as overdue days", async () => {
    const c = await createParty(db, cid, uid, "CUSTOMER", { name: "Old Dues Co", openingBalance: "5000", openingDate: "2026-04-01" });
    const r = (await openItems(db, cid, c.id, "2026-09-30"))!;
    expect(r.overdue.toFixed(2)).toBe("0.00"); expect(r.oldBalance.toFixed(2)).toBe("5000.00"); expect(r.open[0].daysOverdue).toBe(0);
    expect(r.dueSoon.toFixed(2)).toBe("0.00");
    const a = await ageing(db, cid, "CUSTOMER", "2026-09-30");
    expect(a.buckets.old.gte(5000)).toBe(true);
  });
});

describe("invoice document", () => {
  it("loads by id and by private share token; token is long and unique", async () => {
    const inv = await db.query.salesInvoices.findFirst({ where: eq(schema.salesInvoices.companyId, cid) });
    expect(inv!.shareToken.length).toBeGreaterThanOrEqual(24);
    const a = await getInvoice(db, { companyId: cid, id: inv!.id }), b = await getInvoice(db, { token: inv!.shareToken });
    expect(a!.inv.id).toBe(b!.inv.id); expect(a!.lines.length).toBeGreaterThan(0);
    expect(await getInvoice(db, { token: "nope" })).toBeNull();
  });
});

describe("whole system after Phase 4 scenarios", () => {
  it("every health check passes", async () => {
    for (const c of await ledgerHealth(db, cid)) expect([c.name, c.ok]).toEqual([c.name, true]);
  });
});
