import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, updateBusinessInfo, authenticate, changeOwnPassword, signupOpen } from "@/lib/services/company";
import { createParty, recordCustomerPayment, partyStatement } from "@/lib/services/parties";
import { createProduct, adjustStock } from "@/lib/services/inventory";
import { createSale, cancelSale, getInvoice } from "@/lib/services/sales";
import { reverseEntry, setOpeningBalances } from "@/lib/services/vouchers";
import { entryDetail, accountLedger } from "@/lib/accounting/reports";
import { confirmMatch, importStatement } from "@/lib/bank/reconcile";

afterAll(async () => { await pool.end(); });
const A = { cid: "", uid: "", bank: "", party: "", product: "", invoice: "", entry: "" }, B = { cid: "", uid: "", bank: "" };
const email = `sec_${Date.now()}@t.in`;

beforeAll(async () => {
  const a = await registerOwner(db, { name: "A", email, password: "secret123", businessName: "A" });
  A.cid = a.company.id; A.uid = a.user.id;
  await updateBusinessInfo(db, A.cid, A.uid, { name: "A", stateCode: "21" });
  A.bank = (await addBankAccount(db, A.cid, A.uid, { bankName: "SBI" })).accountId;
  await setOpeningBalances(db, { companyId: A.cid, userId: A.uid, date: "2026-04-01", balances: { [A.bank]: "1000" } });
  A.product = (await createProduct(db, A.cid, A.uid, { name: "P", hsn: "8507", gstRate: "18", gstConfirmed: true, openingQty: "5", openingRate: "100", openingDate: "2026-04-01" })).id;
  A.party = (await createParty(db, A.cid, A.uid, "CUSTOMER", { name: "C" })).id;
  const s = await createSale(db, { companyId: A.cid, userId: A.uid, partyId: A.party, date: "2026-05-01", lines: [{ productId: A.product, qty: "1", rate: "200" }] });
  A.invoice = s.invoice.id; A.entry = s.invoice.entryId;
  const b = await registerOwner(db, { name: "B", email: `secb_${Date.now()}@t.in`, password: "secret123", businessName: "B" });
  B.cid = b.company.id; B.uid = b.user.id;
  await updateBusinessInfo(db, B.cid, B.uid, { name: "B", stateCode: "21" });
  B.bank = (await addBankAccount(db, B.cid, B.uid, { bankName: "HDFC" })).accountId;
});

describe("one business can never touch another's books", () => {
  const as = () => ({ companyId: B.cid, userId: B.uid });
  it("reads return nothing", async () => {
    expect(await entryDetail(db, B.cid, A.entry)).toBeNull();
    expect(await getInvoice(db, { companyId: B.cid, id: A.invoice })).toBeNull();
    expect(await partyStatement(db, B.cid, A.party)).toBeNull();
    expect(await accountLedger(db, B.cid, A.bank, "2026-01-01", "2026-12-31")).toBeNull();
  });
  it("writes are refused", async () => {
    await expect(reverseEntry(db, { ...as(), entryId: A.entry, reason: "x" })).rejects.toThrow(/not found/);
    await expect(cancelSale(db, { ...as(), invoiceId: A.invoice, reason: "x" })).rejects.toThrow(/not found/);
    await expect(adjustStock(db, { ...as(), productId: A.product, reason: "DAMAGED" as never, qty: "1", date: "2026-05-02" })).rejects.toThrow();
    await expect(recordCustomerPayment(db, { ...as(), partyId: A.party, cashBankId: B.bank, amount: "10", date: "2026-05-02" })).rejects.toThrow(/not found/);
    await expect(createSale(db, { ...as(), partyId: A.party, date: "2026-05-02", lines: [{ productId: A.product, qty: "1", rate: "1" }] })).rejects.toThrow();
    await expect(importStatement(db, { ...as(), accountId: A.bank, fileName: "x", parsed: { lines: [{ date: "2026-05-01", narration: "x", ref: null, withdrawal: "0.00", deposit: "1.00", balance: null }], skipped: 0, opening: null, closing: null, balanceBreaks: [], columns: {} } })).rejects.toThrow(/bank accounts/);
    const st = await importStatement(db, { companyId: A.cid, userId: A.uid, accountId: A.bank, fileName: "a", parsed: { lines: [{ date: "2026-05-01", narration: "y", ref: null, withdrawal: "0.00", deposit: "1000.00", balance: null }], skipped: 0, opening: null, closing: null, balanceBreaks: [], columns: {} } });
    const line = await db.query.bankStatementLines.findFirst({ where: eq(schema.bankStatementLines.statementId, st.statement.id) });
    await expect(confirmMatch(db, { ...as(), bankLineId: line!.id, journalLineId: A.entry })).rejects.toThrow(/not found/);
    // A's books untouched
    const inv = await getInvoice(db, { companyId: A.cid, id: A.invoice });
    expect(inv!.inv.status).toBe("ACTIVE");
  });
});

describe("sign-in protection", () => {
  it("5 wrong passwords pause sign-in for that email, even with the right password; other emails unaffected", async () => {
    for (let i = 0; i < 5; i++) await expect(authenticate(db, email, "wrong-pass", "1.2.3.4")).rejects.toThrow(/incorrect/);
    await expect(authenticate(db, email, "secret123", "1.2.3.4")).rejects.toThrow(/paused/);
    await expect(authenticate(db, `nobody_${Date.now()}@t.in`, "x", "9.9.9.9")).rejects.toThrow(/incorrect/);
  });
  it("unknown email gets the same message", async () => {
    await expect(authenticate(db, "ghost@t.in", "whatever1", null)).rejects.toThrow("Email or password is incorrect.");
  });
  it("changing password invalidates older sessions", async () => {
    await changeOwnPassword(db, B.uid, "secret123", "newsecret123");
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, B.uid) });
    expect(u!.sessionsValidAfter).toBeInstanceOf(Date);
    expect(Date.now() - u!.sessionsValidAfter!.getTime()).toBeLessThan(10000);
  });
  it("sign-up closes once an owner exists (unless ALLOW_SIGNUP=true)", async () => {
    expect(await signupOpen(db)).toBe(false);
    process.env.ALLOW_SIGNUP = "true"; expect(await signupOpen(db)).toBe(true); delete process.env.ALLOW_SIGNUP;
  });
});
