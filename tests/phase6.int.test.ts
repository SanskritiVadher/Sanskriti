import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, updateBusinessInfo, updateGstInfo } from "@/lib/services/company";
import { createParty, recordCustomerPayment, recordSupplierPayment } from "@/lib/services/parties";
import { createProduct, adjustStock } from "@/lib/services/inventory";
import { createSale } from "@/lib/services/sales";
import { createBill } from "@/lib/services/purchases";
import { createCreditNote, returnableLines } from "@/lib/services/notes";
import { recordPayment, recordContra, setOpeningBalances } from "@/lib/services/vouchers";
import { ownerMoney, depreciation, unpaidBill } from "@/lib/services/corrections";
import { recordGstPayment } from "@/lib/services/gst";
import { postEntry } from "@/lib/accounting/engine";
import { profitAndLoss, balanceSheet, cashFlow, previousPeriod, explainChange } from "@/lib/accounting/statements";
import { trialBalance } from "@/lib/accounting/reports";
import { gstinCheckChar } from "@/lib/gst/gstin";
import { setPeriodLock, listPeriods } from "@/lib/services/periods";
import { D } from "@/lib/money";

afterAll(async () => { await pool.end(); });
const g = (b: string) => b + gstinCheckChar(b);
let cid = "", uid = "", bank = "", cash = "";

beforeAll(async () => {
  const r = await registerOwner(db, { name: "S", email: `st_${Date.now()}@t.in`, password: "secret123", businessName: "Stmt Co" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "Stmt Co", stateCode: "21" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  const acc = Object.fromEntries((await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })).filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
  cash = acc.CASH;
  // Opening position (1 Apr): cash, bank, van, loan
  await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [cash]: "20000", [bank]: "300000", [acc.FIXED_VEHICLES]: "400000", [acc.BANK_LOAN]: "250000" } });
  const bat = await createProduct(db, cid, uid, { name: "Battery", hsn: "8507", gstRate: "18", gstConfirmed: true, openingQty: "10", openingRate: "4000", openingDate: "2026-04-01" });
  const fan = await createProduct(db, cid, uid, { name: "Fan", hsn: "8414", gstRate: "18", gstConfirmed: true });
  const sup = await createParty(db, cid, uid, "SUPPLIER", { name: "Sup", gstin: g("21BBBBB2222B1Z"), openingBalance: "60000", openingDate: "2026-04-01" });
  const cust = await createParty(db, cid, uid, "CUSTOMER", { name: "Cust", gstin: g("21CCCCC3333C1Z"), openingBalance: "45000", openingDate: "2026-04-01" });
  // AUGUST: a quieter month (for comparison)
  await createSale(db, { companyId: cid, userId: uid, partyId: cust.id, date: "2026-08-10", lines: [{ productId: bat.id, qty: "4", rate: "5000" }] });
  await recordPayment(db, { companyId: cid, userId: uid, date: "2026-08-31", amount: "15000", cashBankId: bank, toAccountId: acc.RENT });
  // SEPTEMBER: busier, with every kind of transaction
  await createBill(db, { companyId: cid, userId: uid, partyId: sup.id, billNumber: "B1", date: "2026-09-01", lines: [{ productId: bat.id, qty: "20", rate: "4200" }, { productId: fan.id, qty: "10", rate: "1800" }] });
  const s1 = await createSale(db, { companyId: cid, userId: uid, partyId: cust.id, date: "2026-09-05", lines: [{ productId: bat.id, qty: "12", rate: "5200" }, { productId: fan.id, qty: "6", rate: "2300" }] });
  await createSale(db, { companyId: cid, userId: uid, partyId: cust.id, date: "2026-09-08", lines: [{ productId: fan.id, qty: "2", rate: "2300" }], paidNow: { amount: "5428", cashBankId: cash } });
  const [l1] = await returnableLines(db, "CREDIT_NOTE", s1.invoice.id);
  await createCreditNote(db, { companyId: cid, userId: uid, invoiceId: s1.invoice.id, date: "2026-09-12", reason: "faulty", lines: [{ sourceLineId: l1.id, qty: "1" }] });
  await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: cust.id, cashBankId: bank, amount: "70000", date: "2026-09-15" });
  await recordSupplierPayment(db, { companyId: cid, userId: uid, partyId: sup.id, cashBankId: bank, amount: "100000", date: "2026-09-16" });
  await recordPayment(db, { companyId: cid, userId: uid, date: "2026-09-30", amount: "15000", cashBankId: bank, toAccountId: acc.RENT });
  await recordPayment(db, { companyId: cid, userId: uid, date: "2026-09-30", amount: "24000", cashBankId: bank, toAccountId: acc.SALARIES });
  await unpaidBill(db, { companyId: cid, userId: uid, date: "2026-09-30", amount: "3500", expenseId: acc.ELECTRICITY });
  await recordContra(db, { companyId: cid, userId: uid, date: "2026-09-20", amount: "10000", fromId: cash, toId: bank });
  await ownerMoney(db, { companyId: cid, userId: uid, date: "2026-09-21", amount: "8000", cashBankId: bank, direction: "OUT" });
  await adjustStock(db, { companyId: cid, userId: uid, productId: fan.id, reason: "DAMAGED", qty: "1", date: "2026-09-22" });
  await depreciation(db, { companyId: cid, userId: uid, date: "2026-09-30", amount: "5000", assetId: acc.FIXED_VEHICLES });
  await postEntry(db, { companyId: cid, userId: uid, voucherType: "PAYMENT", date: "2026-09-25", narration: "Loan EMI principal",
    lines: [{ systemKey: "BANK_LOAN", debit: "10000" }, { systemKey: "INTEREST_EXPENSE", debit: "2500" }, { accountId: bank, credit: "12500" }] });
  await recordGstPayment(db, { companyId: cid, userId: uid, asOf: "2026-08-31", paidOn: "2026-09-20", bankId: bank });
});

describe("Profit & loss", () => {
  it("is correct line by line and equals income − expense", async () => {
    const p = await profitAndLoss(db, cid, "2026-09-01", "2026-09-30");
    // Sales: 12×5200 + 6×2300 + 2×2300 = 62,400 + 13,800 + 4,600 = 80,800; return 1×5200
    expect(p.sales.toFixed(2)).toBe("80800.00"); expect(p.returns.toFixed(2)).toBe("5200.00"); expect(p.netSales.toFixed(2)).toBe("75600.00");
    expect(p.reconciles).toBe(true);
    const tb = await trialBalance(db, cid, "2026-09-30");
    expect(tb.balanced).toBe(true);
    // Expenses include rent 15,000, salary 24,000, electricity 3,500, depreciation 5,000, interest 2,500
    const exp = Object.fromEntries(p.expenses.map((e) => [e.system_key, e.amount.toFixed(2)]));
    expect(exp).toMatchObject({ RENT: "15000.00", SALARIES: "24000.00", ELECTRICITY: "3500.00", DEPRECIATION: "5000.00", INTEREST_EXPENSE: "2500.00" });
    expect(p.netProfit.toFixed(2)).toBe(p.grossProfit.plus(p.otherIncomeTotal).minus(p.expensesTotal).toFixed(2));
  });
  it("explains the change vs last month with parts that add up exactly", async () => {
    const now = await profitAndLoss(db, cid, "2026-09-01", "2026-09-30");
    const pp = previousPeriod("2026-09-01", "2026-09-30");
    expect(pp).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    const prev = await profitAndLoss(db, cid, pp.from, pp.to);
    const x = explainChange(now, prev);
    expect(x.change.toFixed(2)).toBe(now.netProfit.minus(prev.netProfit).toFixed(2));
    expect(x.parts.reduce((s, p) => s.plus(p.effect), D(0)).toFixed(2)).toBe(x.change.toFixed(2));
    expect(x.parts.map((p) => p.label)).toContain("Higher staff salaries");
  });
  it("previous period for ranges", () => {
    expect(previousPeriod("2026-07-01", "2026-09-30")).toEqual({ from: "2026-04-01", to: "2026-06-30" });
    expect(previousPeriod("2026-09-10", "2026-09-19")).toEqual({ from: "2026-08-31", to: "2026-09-09" });
  });
});

describe("Balance sheet", () => {
  it("balances at several dates, and this year's profit equals the P&L", async () => {
    for (const d of ["2026-04-01", "2026-08-31", "2026-09-15", "2026-09-30", "2027-03-31"]) {
      const b = await balanceSheet(db, cid, d);
      expect([d, b.balanced]).toEqual([d, true]);
    }
    const b = await balanceSheet(db, cid, "2026-09-30");
    const ytd = await profitAndLoss(db, cid, "2026-04-01", "2026-09-30");
    expect(b.profitThisYear.toFixed(2)).toBe(ytd.netProfit.toFixed(2));
    expect(b.earlierProfit.toFixed(2)).toBe("0.00");
    expect(b.fixed.find((x) => x.system_key === "FIXED_VEHICLES")!.amount.toFixed(2)).toBe("395000.00");
    expect(b.loans[0].amount.toFixed(2)).toBe("240000.00");
  });
  it("next year: last year's profit moves to 'earlier years' without any closing entry", async () => {
    await postEntry(db, { companyId: cid, userId: uid, voucherType: "RECEIPT", date: "2027-04-02", lines: [{ accountId: bank, debit: "1000" }, { systemKey: "OTHER_INCOME", credit: "1000" }] });
    const last = await profitAndLoss(db, cid, "2026-04-01", "2027-03-31");
    const b = await balanceSheet(db, cid, "2027-04-30");
    expect(b.earlierProfit.toFixed(2)).toBe(last.netProfit.toFixed(2));
    expect(b.profitThisYear.toFixed(2)).toBe("1000.00");
    expect(b.balanced).toBe(true);
  });
});

describe("Cash flow", () => {
  it("direct and indirect both equal the change in cash + bank (month)", async () => {
    const c = await cashFlow(db, cid, "2026-09-01", "2026-09-30");
    expect(c.reconciles).toBe(true);
    expect(c.directNet.toFixed(2)).toBe(c.change.toFixed(2));
    expect(c.indirect.net.toFixed(2)).toBe(c.change.toFixed(2));
    const by = Object.fromEntries(c.direct.map((d) => [d.cat, d.amount.toFixed(2)]));
    expect(by.customers).toBe("75428.00");     // 70,000 + 5,428
    expect(by.suppliers).toBe("-100000.00");
    expect(by.owner).toBe("-8000.00");
    expect(by.loans).toBe("-10000.00");
    expect(D(by.expenses).toFixed(2)).toBe("-41500.00"); // rent 15,000 + salary 24,000 + interest 2,500
  });
  it("reconciles over the whole year including opening balances inside the range", async () => {
    const c = await cashFlow(db, cid, "2026-04-01", "2027-03-31");
    expect(c.reconciles).toBe(true);
    expect(c.openingBooked.toFixed(2)).toBe("320000.00");
  });
});

describe("year lock", () => {
  it("only finished years can be locked; locked years refuse entries; only the owner reopens", async () => {
    const periods = await listPeriods(db, cid);
    const fy26 = periods.find((p) => p.name === "FY 2026-27")!;
    await expect(setPeriodLock(db, { companyId: cid, userId: uid, periodId: fy26.id, lock: true, reason: "x", role: "OWNER" })).rejects.toThrow(/after it ends/);
    const [old] = await db.insert(schema.financialPeriods).values({ companyId: cid, name: "FY 2024-25", startDate: "2024-04-01", endDate: "2025-03-31" }).returning();
    await setPeriodLock(db, { companyId: cid, userId: uid, periodId: old.id, lock: true, reason: "Finalised by CA", role: "OWNER" });
    await expect(postEntry(db, { companyId: cid, userId: uid, voucherType: "JOURNAL", date: "2024-06-01", lines: [{ accountId: cash, debit: "1" }, { systemKey: "CAPITAL", credit: "1" }] })).rejects.toThrow(/closed/);
    await expect(setPeriodLock(db, { companyId: cid, userId: uid, periodId: old.id, lock: false, reason: "fix", role: "ACCOUNTANT" })).rejects.toThrow(/Only the owner/);
    await setPeriodLock(db, { companyId: cid, userId: uid, periodId: old.id, lock: false, reason: "CA asked for a correction", role: "OWNER" });
  });
});

describe("depreciation calculator", () => {
  it("works out the amount from a rate on current value, with half-year option", async () => {
    const acc = Object.fromEntries((await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })).filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
    const bs = await balanceSheet(db, cid, "2027-03-31");
    const van = bs.fixed.find((x) => x.system_key === "FIXED_VEHICLES")!.amount;
    const e = await depreciation(db, { companyId: cid, userId: uid, date: "2027-03-31", assetId: acc.FIXED_VEHICLES, ratePct: "15" });
    expect(e.totalAmount).toBe(van.mul(0.15).toFixed(2));
    const e2 = await depreciation(db, { companyId: cid, userId: uid, date: "2027-03-31", assetId: acc.FIXED_VEHICLES, ratePct: "15", halfYear: true });
    expect(e2.totalAmount).toBe(van.mul(0.85).mul(0.075).toDecimalPlaces(2).toFixed(2));
    await expect(depreciation(db, { companyId: cid, userId: uid, date: "2027-03-31", assetId: acc.FIXED_VEHICLES })).rejects.toThrow(/rate like 15/);
  });
});
