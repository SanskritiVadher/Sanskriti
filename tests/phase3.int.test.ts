import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, addBrand } from "@/lib/services/company";
import { createParty, updateParty, setPartyOpening, partyBalances, partyStatement, recordCustomerPayment, recordSupplierPayment, normalisePhone, whatsappReminderLink } from "@/lib/services/parties";
import { createProduct, updateProduct, adjustStock, stockOf, stockList, inventoryReconciliation, suggestSku } from "@/lib/services/inventory";
import { moveCategory, unpaidBill, ownerMoney, depreciation } from "@/lib/services/corrections";
import { postEntry, reverseEntry } from "@/lib/accounting/engine";
import { recordPayment, setOpeningBalances } from "@/lib/services/vouchers";
import { trialBalance, ledgerHealth, naturalBalance } from "@/lib/accounting/reports";
import { gstinCheckChar } from "@/lib/gst/gstin";
import { D } from "@/lib/money";

afterAll(async () => { await pool.end(); });
let cid = "", uid = "", brandSF = "", bank = "";
const acc: Record<string, string> = {};
const gst = (b: string) => b + gstinCheckChar(b);
const bal = async (k: string) => { const tb = await trialBalance(db, cid, "2027-03-31"); const r = tb.rows.find((x) => x.accountId === acc[k])!; return naturalBalance(r.nature, r.totalDebit, r.totalCredit).toFixed(2); };

beforeAll(async () => {
  const r = await registerOwner(db, { name: "P3", email: `p3_${Date.now()}@t.in`, password: "secret123", businessName: "P3 Traders" });
  cid = r.company.id; uid = r.user.id;
  brandSF = (await addBrand(db, cid, uid, "SF Sonic")).id;
  bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  for (const a of await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })) if (a.systemKey) acc[a.systemKey] = a.id;
});

describe("phone + helpers", () => {
  it("normalises Indian mobiles", () => {
    expect(normalisePhone("+91 98765-43210")).toBe("9876543210");
    expect(normalisePhone("09876543210")).toBe("9876543210");
    expect(normalisePhone("12345")).toBe("INVALID");
    expect(normalisePhone("")).toBeNull();
    expect(suggestSku("SF Sonic Battery 35Ah")).toBe("SF-SONIC-BATTERY-35AH");
  });
});

describe("customers & suppliers", () => {
  let cust = "", sup = "";
  it("creates a customer with opening dues posted to the ledger, tagged to them", async () => {
    const c = await createParty(db, cid, uid, "CUSTOMER", { name: "Ravi Traders", phone: "98765 43210", gstin: gst("21ABCDE1234F1Z"), creditLimit: "2,00,000", creditDays: "30", openingBalance: "84000", openingDate: "2026-04-01" });
    cust = c.id;
    expect(c.stateCode).toBe("21"); expect(c.whatsapp).toBe("9876543210"); expect(c.creditLimit).toBe("200000.00");
    expect((await partyBalances(db, cid, "CUSTOMER")).get(cust)!.balance.toFixed(2)).toBe("84000.00");
    expect(await bal("DEBTORS_CONTROL")).toBe("84000.00");
    expect((await trialBalance(db, cid, "2027-03-31")).balanced).toBe(true);
  });
  it("rejects duplicates, bad GSTIN, GSTIN/state mismatch, bad phone", async () => {
    await expect(createParty(db, cid, uid, "CUSTOMER", { name: "ravi traders" })).rejects.toThrow(/already exists/);
    await expect(createParty(db, cid, uid, "CUSTOMER", { name: "X1", gstin: "21ABCDE1234F1ZZ" })).rejects.toThrow(/GSTIN/);
    await expect(createParty(db, cid, uid, "CUSTOMER", { name: "X2", gstin: gst("27ABCDE1234F1Z"), stateCode: "21" })).rejects.toThrow(/Maharashtra/);
    await expect(createParty(db, cid, uid, "CUSTOMER", { name: "X3", phone: "555" })).rejects.toThrow(/10-digit/);
    await expect(createParty(db, cid, uid, "CUSTOMER", { name: "X4", gstin: gst("21ABCDE1234F1Z") })).rejects.toThrow(/already used/);
  });
  it("records a customer payment that reduces their dues", async () => {
    await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: cust, cashBankId: bank, amount: "30000", date: "2026-09-10" });
    const s = (await partyStatement(db, cid, cust))!;
    expect(s.balance.toFixed(2)).toBe("54000.00");
    expect(s.lines).toHaveLength(2);
    expect(await bal("BANK" in acc ? "BANK" : "DEBTORS_CONTROL")).toBe("54000.00");
  });
  it("supplier opening (we owe) and payment", async () => {
    const s = await createParty(db, cid, uid, "SUPPLIER", { name: "SF Distributors", openingBalance: "150000", openingDate: "2026-04-01" });
    sup = s.id;
    await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [bank]: "500000" } });
    await recordSupplierPayment(db, { companyId: cid, userId: uid, partyId: sup, cashBankId: bank, amount: "50000", date: "2026-09-12" });
    expect((await partyBalances(db, cid, "SUPPLIER")).get(sup)!.balance.toFixed(2)).toBe("100000.00");
    expect(await bal("CREDITORS_CONTROL")).toBe("100000.00");
  });
  it("replacing an opening balance reverses the old one", async () => {
    await setPartyOpening(db, cid, uid, cust, "90000", "2026-04-01");
    expect((await partyBalances(db, cid, "CUSTOMER")).get(cust)!.balance.toFixed(2)).toBe("60000.00"); // 90000 - 30000 paid
    const openings = await db.query.journalEntries.findMany({ where: and(eq(schema.journalEntries.sourceType, "opening_party"), eq(schema.journalEntries.sourceId, cust)) });
    expect(openings.map((e) => e.status).sort()).toEqual(["POSTED", "POSTED", "REVERSED"]); // original, reversal, new
  });
  it("company opening balances ignore party openings (separate sourceType)", async () => {
    await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [bank]: "500000" } });
    expect((await partyBalances(db, cid, "CUSTOMER")).get(cust)!.balance.toFixed(2)).toBe("60000.00");
  });
  it("engine demands a party on debtors/creditors and the right type", async () => {
    await expect(postEntry(db, { companyId: cid, userId: uid, voucherType: "JOURNAL", date: "2026-09-01",
      lines: [{ systemKey: "DEBTORS_CONTROL", debit: "1" }, { systemKey: "SALES", credit: "1" }] })).rejects.toThrow(/choose which customer/);
    await expect(postEntry(db, { companyId: cid, userId: uid, voucherType: "JOURNAL", date: "2026-09-01",
      lines: [{ systemKey: "DEBTORS_CONTROL", partyId: sup, debit: "1" }, { systemKey: "SALES", credit: "1" }] })).rejects.toThrow(/needs a customer/);
    await expect(postEntry(db, { companyId: cid, userId: uid, voucherType: "JOURNAL", date: "2026-09-01",
      lines: [{ systemKey: "RENT", partyId: cust, debit: "1" }, { systemKey: "CASH", credit: "1" }] })).rejects.toThrow(/can't be tagged/);
  });
  it("database refuses untagged debtor lines even if the engine is bypassed", async () => {
    const e = await db.query.journalEntries.findFirst({ where: eq(schema.journalEntries.companyId, cid) });
    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.journalLines).values({ entryId: e!.id, companyId: cid, accountId: acc.DEBTORS_CONTROL, lineNo: 50, debit: "1.00" });
    })).rejects.toThrow();
  });
  it("reversing a customer payment restores their dues", async () => {
    const pay = await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: cust, cashBankId: bank, amount: "5000", date: "2026-09-15" });
    await reverseEntry(db, { companyId: cid, userId: uid, entryId: pay.id, reason: "cheque bounced" });
    expect((await partyBalances(db, cid, "CUSTOMER")).get(cust)!.balance.toFixed(2)).toBe("60000.00");
  });
  it("builds a WhatsApp reminder link", () => {
    const l = whatsappReminderLink({ whatsapp: "9876543210", name: "Ravi Traders" }, "P3 Traders", "₹60,000.00")!;
    expect(l.startsWith("https://wa.me/919876543210?text=")).toBe(true);
    expect(decodeURIComponent(l)).toContain("₹60,000.00");
  });
  it("edits a party without touching balances", async () => {
    const u = await updateParty(db, cid, uid, cust, { name: "Ravi Traders Pvt", phone: "9876543210", creditDays: "45" });
    expect(u.creditDays).toBe(45);
    expect((await partyBalances(db, cid, "CUSTOMER")).get(cust)!.balance.toFixed(2)).toBe("60000.00");
  });
});

describe("products & stock (weighted average)", () => {
  let p35 = "";
  it("creates a product with opening stock; ledger stock = stock records", async () => {
    const p = await createProduct(db, cid, uid, { name: "SF Sonic 35Ah", brandId: brandSF, categoryName: "Batteries", hsn: "8507", gstRate: "18",
      purchasePrice: "4500", dealerPrice: "5000", reorderLevel: "5", trackSerial: true, warrantyMonths: "24", openingQty: "20", openingRate: "4500", openingDate: "2026-04-01" });
    p35 = p.id;
    expect(p.gstRateStatus).toBe("UNVERIFIED");
    const s = await stockOf(db, p35);
    expect(s.qty.toString()).toBe("20"); expect(s.value.toFixed(2)).toBe("90000.00");
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
  });
  it("averages cost correctly and removes exact value when emptying", async () => {
    await adjustStock(db, { companyId: cid, userId: uid, productId: p35, reason: "FOUND", qty: "1", date: "2026-05-01" }); // at avg 4500
    await adjustStock(db, { companyId: cid, userId: uid, productId: p35, reason: "COUNT_LESS", qty: "3", date: "2026-05-02" });
    let s = await stockOf(db, p35);
    expect(s.qty.toString()).toBe("18"); expect(s.value.toFixed(2)).toBe("81000.00");
    // create a product with an awkward average: 3 units for 100 => 33.3333
    const odd = await createProduct(db, cid, uid, { name: "Odd Item", openingQty: "3", openingRate: "33.33", openingDate: "2026-04-01" });
    await adjustStock(db, { companyId: cid, userId: uid, productId: odd.id, reason: "DAMAGED", qty: "1", date: "2026-05-03" });
    await adjustStock(db, { companyId: cid, userId: uid, productId: odd.id, reason: "DAMAGED", qty: "2", date: "2026-05-03" });
    s = await stockOf(db, odd.id);
    expect(s.qty.toString()).toBe("0"); expect(s.value.toFixed(2)).toBe("0.00");
    expect((await inventoryReconciliation(db, cid)).ok).toBe(true);
  });
  it("refuses to remove more than is in stock, and needs a cost when adding to empty stock", async () => {
    await expect(adjustStock(db, { companyId: cid, userId: uid, productId: p35, reason: "LOST", qty: "100", date: "2026-05-04" })).rejects.toThrow(/Only 18/);
    const e = await createProduct(db, cid, uid, { name: "Empty Item" });
    await expect(adjustStock(db, { companyId: cid, userId: uid, productId: e.id, reason: "FOUND", qty: "1", date: "2026-05-04" })).rejects.toThrow(/cost per unit/);
    await adjustStock(db, { companyId: cid, userId: uid, productId: e.id, reason: "FOUND", qty: "2", unitCost: "100", date: "2026-05-04" });
    expect((await stockOf(db, e.id)).value.toFixed(2)).toBe("200.00");
  });
  it("stock taken for personal use goes to drawings", async () => {
    const before = await bal("DRAWINGS");
    await adjustStock(db, { companyId: cid, userId: uid, productId: p35, reason: "OWN_USE", qty: "1", date: "2026-06-01" });
    // Drawings reduce the owner's stake: equity balance goes down by the stock cost.
    expect(D(await bal("DRAWINGS")).minus(before).toFixed(2)).toBe("-4500.00");
  });
  it("validates product fields and duplicates", async () => {
    await expect(createProduct(db, cid, uid, { name: "sf sonic 35ah" })).rejects.toThrow(/already exists/);
    await expect(createProduct(db, cid, uid, { name: "New", sku: "SF-SONIC-35AH" })).rejects.toThrow(/already used/);
    await expect(createProduct(db, cid, uid, { name: "New2", hsn: "85" })).rejects.toThrow(/HSN/);
    await expect(createProduct(db, cid, uid, { name: "New3", gstRate: "80" })).rejects.toThrow(/too high/);
    await expect(createProduct(db, cid, uid, { name: "New4", openingQty: "5" })).rejects.toThrow(/cost per unit/);
    const u = await updateProduct(db, cid, uid, p35, { name: "SF Sonic 35Ah", sku: "SF-SONIC-35AH", gstRate: "18", gstConfirmed: true, reorderLevel: "20", brandId: brandSF });
    expect(u.gstRateStatus).toBe("USER_CONFIRMED");
  });
  it("stock list flags low stock and totals match", async () => {
    const list = await stockList(db, cid);
    const r = list.find((x) => x.id === p35)!;
    expect(r.qty.toString()).toBe("17"); expect(r.status).toBe("LOW");
    const total = list.reduce((s, x) => s.plus(x.value), D(0));
    expect(total.toFixed(2)).toBe((await inventoryReconciliation(db, cid)).stock.toFixed(2));
  });
  it("stock movements cannot be edited or deleted", async () => {
    const t = await db.query.inventoryTransactions.findFirst({ where: eq(schema.inventoryTransactions.companyId, cid) });
    await expect(db.update(schema.inventoryTransactions).set({ quantity: "999" }).where(eq(schema.inventoryTransactions.id, t!.id))).rejects.toThrow();
    await expect(db.delete(schema.inventoryTransactions).where(eq(schema.inventoryTransactions.id, t!.id))).rejects.toThrow();
  });
});

describe("guided corrections", () => {
  it("moves a wrong category, records an unpaid bill, owner money and depreciation", async () => {
    await recordPayment(db, { companyId: cid, userId: uid, date: "2026-07-01", amount: "3000", cashBankId: bank, toAccountId: acc.OFFICE_EXPENSES });
    await moveCategory(db, { companyId: cid, userId: uid, date: "2026-07-02", amount: "3000", fromId: acc.OFFICE_EXPENSES, toId: acc.FREIGHT_OUTWARD });
    expect(await bal("OFFICE_EXPENSES")).toBe("0.00"); expect(await bal("FREIGHT_OUTWARD")).toBe("3000.00");
    await expect(moveCategory(db, { companyId: cid, userId: uid, date: "2026-07-02", amount: "1", fromId: acc.OFFICE_EXPENSES, toId: acc.RENT })).rejects.toThrow(/only has/);
    await expect(moveCategory(db, { companyId: cid, userId: uid, date: "2026-07-02", amount: "1", fromId: acc.RENT, toId: acc.OTHER_INCOME })).rejects.toThrow(/Both must be expense/);
    await unpaidBill(db, { companyId: cid, userId: uid, date: "2026-07-31", amount: "4000", expenseId: acc.ELECTRICITY });
    expect(await bal("EXPENSES_PAYABLE")).toBe("4000.00");
    await ownerMoney(db, { companyId: cid, userId: uid, date: "2026-08-01", amount: "10000", cashBankId: bank, direction: "OUT" });
    await ownerMoney(db, { companyId: cid, userId: uid, date: "2026-08-02", amount: "25000", cashBankId: bank, direction: "IN" });
    expect(await bal("CAPITAL")).toBe("25000.00");
    await postEntry(db, { companyId: cid, userId: uid, voucherType: "JOURNAL", date: "2026-04-01", lines: [{ systemKey: "FIXED_VEHICLES", debit: "300000" }, { systemKey: "CAPITAL", credit: "300000" }] });
    await depreciation(db, { companyId: cid, userId: uid, date: "2027-03-31", amount: "45000", assetId: acc.FIXED_VEHICLES });
    expect(await bal("FIXED_VEHICLES")).toBe("255000.00");
    await expect(depreciation(db, { companyId: cid, userId: uid, date: "2027-03-31", amount: "999999", assetId: acc.FIXED_VEHICLES })).rejects.toThrow(/can't be more/);
  });
});

describe("whole-system health after everything above", () => {
  it("all checks pass", async () => {
    const h = await ledgerHealth(db, cid);
    for (const c of h) expect([c.name, c.ok]).toEqual([c.name, true]);
    expect((await trialBalance(db, cid, "2027-03-31")).balanced).toBe(true);
  });
});
