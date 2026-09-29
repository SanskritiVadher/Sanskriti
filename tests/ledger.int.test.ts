import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, addUser, resetUserPassword, setUserActive, authenticate } from "@/lib/services/company";
import { postEntry, reverseEntry, validateLines, LedgerError } from "@/lib/accounting/engine";
import { trialBalance, accountLedger, ledgerHealth, moneyPosition, naturalBalance } from "@/lib/accounting/reports";
import { recordReceipt, recordPayment, recordContra, setOpeningBalances, currentOpening } from "@/lib/services/vouchers";
import { D } from "@/lib/money";

afterAll(async () => { await pool.end(); });

let companyId = "", userId = "", bankId = "";
const acc: Record<string, string> = {};
const bal = async (key: string, asOf = "2027-03-31") => {
  const tb = await trialBalance(db, companyId, asOf);
  const r = tb.rows.find((x) => x.accountId === acc[key])!;
  return naturalBalance(r.nature, r.totalDebit, r.totalCredit).toFixed(2);
};
const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(schema.journalEntries).where(eq(schema.journalEntries.companyId, companyId)))[0].n;

beforeAll(async () => {
  const r = await registerOwner(db, { name: "Ledger Owner", email: `ledger${Date.now()}@t.in`, password: "secret123", businessName: "Ledger Co" });
  companyId = r.company.id; userId = r.user.id;
  const b = await addBankAccount(db, companyId, userId, { bankName: "SBI" });
  bankId = b.accountId;
  const all = await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, companyId) });
  for (const a of all) if (a.systemKey) acc[a.systemKey] = a.id;
  acc.BANK = bankId;
});

describe("validateLines (pure)", () => {
  it("accepts a balanced entry and totals exactly", () => {
    const r = validateLines([{ systemKey: "CASH", debit: "0.10" }, { systemKey: "CASH", debit: "0.20" }, { systemKey: "SALES", credit: "0.30" }]);
    expect(r.total.toFixed(2)).toBe("0.30"); // float would give 0.30000000000000004
  });
  it("rejects unbalanced, single line, both-sided, zero, negative, 3 decimals", () => {
    expect(() => validateLines([{ systemKey: "CASH", debit: 100 }, { systemKey: "SALES", credit: 99.99 }])).toThrow(/doesn't balance.*0\.01/);
    expect(() => validateLines([{ systemKey: "CASH", debit: 100 }])).toThrow(/at least two/);
    expect(() => validateLines([{ systemKey: "CASH", debit: 1, credit: 1 }, { systemKey: "SALES", credit: 0 }])).toThrow(/either a debit or a credit/);
    expect(() => validateLines([{ systemKey: "CASH", debit: 0 }, { systemKey: "SALES", credit: 0 }])).toThrow(/either/);
    expect(() => validateLines([{ systemKey: "CASH", debit: -5 }, { systemKey: "SALES", credit: -5 }])).toThrow(/negative/);
    expect(() => validateLines([{ systemKey: "CASH", debit: "1.005" }, { systemKey: "SALES", credit: "1.005" }])).toThrow(/2 decimal/);
    expect(() => validateLines([{ systemKey: "CASH", debit: "abc" }, { systemKey: "SALES", credit: 1 }])).toThrow(/valid number/);
  });
});

describe("posting engine (database)", () => {
  it("posts a balanced entry with a sequential voucher number", async () => {
    const e1 = await postEntry(db, { companyId, userId, voucherType: "JOURNAL", date: "2026-05-01", narration: "Capital",
      lines: [{ systemKey: "CASH", debit: "50000" }, { systemKey: "CAPITAL", credit: "50000" }] });
    const e2 = await postEntry(db, { companyId, userId, voucherType: "JOURNAL", date: "2026-05-02",
      lines: [{ accountId: bankId, debit: "10000" }, { systemKey: "CASH", credit: "10000" }] });
    expect(e1.voucherNumber).toBe("JV/2026-27/0001");
    expect(e2.voucherNumber).toBe("JV/2026-27/0002");
    expect(await bal("CASH")).toBe("40000.00");
    expect(await bal("BANK")).toBe("10000.00");
    expect(await bal("CAPITAL")).toBe("50000.00");
  });

  it("numbers restart per financial year and per voucher type", async () => {
    const e = await postEntry(db, { companyId, userId, voucherType: "JOURNAL", date: "2027-04-01",
      lines: [{ systemKey: "CASH", debit: "1" }, { systemKey: "CAPITAL", credit: "1" }] });
    expect(e.voucherNumber).toBe("JV/2027-28/0001");
    const r = await postEntry(db, { companyId, userId, voucherType: "RECEIPT", date: "2026-05-03",
      lines: [{ systemKey: "CASH", debit: "1" }, { systemKey: "OTHER_INCOME", credit: "1" }] });
    expect(r.voucherNumber).toBe("RCT/2026-27/0001");
  });

  it("rejects an unbalanced entry and writes NOTHING", async () => {
    const before = await count();
    await expect(postEntry(db, { companyId, userId, voucherType: "JOURNAL", date: "2026-05-04",
      lines: [{ systemKey: "CASH", debit: "100" }, { systemKey: "CAPITAL", credit: "99" }] })).rejects.toBeInstanceOf(LedgerError);
    expect(await count()).toBe(before);
  });

  it("rejects accounts from another company", async () => {
    const other = await registerOwner(db, { name: "Other", email: `other${Date.now()}@t.in`, password: "secret123", businessName: "Other" });
    const otherCash = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.companyId, other.company.id), eq(schema.accounts.systemKey, "CASH")) });
    await expect(postEntry(db, { companyId, userId, voucherType: "JOURNAL", date: "2026-05-04",
      lines: [{ accountId: otherCash!.id, debit: "5" }, { systemKey: "CAPITAL", credit: "5" }] })).rejects.toThrow(/not found in this business/);
  });

  it("refuses to post into a closed period", async () => {
    const [p] = await db.insert(schema.financialPeriods).values({ companyId, name: "FY 2020-21", startDate: "2020-04-01", endDate: "2021-03-31", isClosed: true }).returning();
    await expect(postEntry(db, { companyId, userId, voucherType: "JOURNAL", date: "2020-06-01",
      lines: [{ systemKey: "CASH", debit: "5" }, { systemKey: "CAPITAL", credit: "5" }] })).rejects.toThrow(/closed/);
    expect(p.isClosed).toBe(true);
  });

  it("rejects invalid dates", async () => {
    await expect(postEntry(db, { companyId, userId, voucherType: "JOURNAL", date: "2026-13-45",
      lines: [{ systemKey: "CASH", debit: "5" }, { systemKey: "CAPITAL", credit: "5" }] })).rejects.toThrow(/valid date/);
  });

  it("gives unique, gap-free numbers under concurrent posting", async () => {
    const posts = Array.from({ length: 10 }, (_, i) => postEntry(db, { companyId, userId, voucherType: "PAYMENT", date: "2026-06-01",
      lines: [{ systemKey: "RENT", debit: String(100 + i) }, { systemKey: "CASH", credit: String(100 + i) }] }));
    const nums = (await Promise.all(posts)).map((e) => Number(e.voucherNumber.split("/")[2])).sort((a, b) => a - b);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("database guards (bypass attempts)", () => {
  it("rejects a direct INSERT of an unbalanced entry at commit", async () => {
    const period = await db.query.financialPeriods.findFirst({ where: eq(schema.financialPeriods.companyId, companyId) });
    await expect(db.transaction(async (tx) => {
      const [e] = await tx.insert(schema.journalEntries).values({ companyId, periodId: period!.id, voucherType: "JOURNAL",
        voucherNumber: "HACK/1", entryDate: "2026-05-05", totalAmount: "100.00", createdBy: userId }).returning();
      await tx.insert(schema.journalLines).values([
        { entryId: e.id, companyId, accountId: acc.CASH, lineNo: 1, debit: "100.00" },
        { entryId: e.id, companyId, accountId: acc.CAPITAL, lineNo: 2, credit: "90.00" }]);
    })).rejects.toThrow();
    expect(await db.query.journalEntries.findFirst({ where: eq(schema.journalEntries.voucherNumber, "HACK/1") })).toBeUndefined();
  });

  it("rejects an entry with no lines", async () => {
    const period = await db.query.financialPeriods.findFirst({ where: eq(schema.financialPeriods.companyId, companyId) });
    await expect(db.insert(schema.journalEntries).values({ companyId, periodId: period!.id, voucherType: "JOURNAL",
      voucherNumber: "HACK/2", entryDate: "2026-05-05", totalAmount: "0.00", createdBy: userId })).rejects.toThrow();
  });

  it("forbids editing or deleting posted lines and entries", async () => {
    const line = await db.query.journalLines.findFirst({ where: eq(schema.journalLines.companyId, companyId) });
    await expect(db.update(schema.journalLines).set({ debit: "1.00" }).where(eq(schema.journalLines.id, line!.id))).rejects.toThrow();
    await expect(db.delete(schema.journalLines).where(eq(schema.journalLines.id, line!.id))).rejects.toThrow();
    await expect(db.update(schema.journalEntries).set({ narration: "edited" }).where(eq(schema.journalEntries.id, line!.entryId))).rejects.toThrow();
    await expect(db.delete(schema.journalEntries).where(eq(schema.journalEntries.id, line!.entryId))).rejects.toThrow();
  });

  it("rejects a line whose account belongs to another company", async () => {
    const other = await db.query.accounts.findFirst({ where: sql`${schema.accounts.companyId} <> ${companyId}` });
    const e = await db.query.journalEntries.findFirst({ where: eq(schema.journalEntries.companyId, companyId) });
    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.journalLines).values({ entryId: e!.id, companyId, accountId: other!.id, lineNo: 99, debit: "1.00" });
    })).rejects.toThrow();
  });
});

describe("reversal", () => {
  it("creates an opposite entry, nets to zero, marks original, and can't be done twice", async () => {
    const cashBefore = await bal("CASH");
    const e = await postEntry(db, { companyId, userId, voucherType: "PAYMENT", date: "2026-07-01",
      lines: [{ systemKey: "ELECTRICITY", debit: "2345.67" }, { systemKey: "CASH", credit: "2345.67" }] });
    expect(await bal("CASH")).toBe(D(cashBefore).minus("2345.67").toFixed(2));
    const rev = await reverseEntry(db, { companyId, userId, entryId: e.id, reason: "Entered twice" });
    expect(rev.voucherNumber).toMatch(/^REV\//);
    expect(await bal("CASH")).toBe(cashBefore);
    const orig = await db.query.journalEntries.findFirst({ where: eq(schema.journalEntries.id, e.id) });
    expect(orig?.status).toBe("REVERSED");
    expect(orig?.reversedById).toBe(rev.id);
    await expect(reverseEntry(db, { companyId, userId, entryId: e.id, reason: "again" })).rejects.toThrow(/already been reversed/);
    await expect(reverseEntry(db, { companyId, userId, entryId: rev.id, reason: "x" })).rejects.toThrow(/can't itself be reversed/);
    await expect(reverseEntry(db, { companyId, userId, entryId: e.id, reason: " " })).rejects.toThrow(/reason/);
  });
});

describe("owner vouchers", () => {
  it("receipt, payment and contra post the right sides", async () => {
    const [c0, b0] = [await bal("CASH"), await bal("BANK")];
    await recordReceipt(db, { companyId, userId, date: "2026-08-01", amount: "5,000", cashBankId: acc.CASH, fromAccountId: acc.OTHER_INCOME });
    await recordPayment(db, { companyId, userId, date: "2026-08-02", amount: "1200.50", cashBankId: acc.BANK, toAccountId: acc.TELEPHONE });
    await recordContra(db, { companyId, userId, date: "2026-08-03", amount: "2000", fromId: acc.CASH, toId: acc.BANK });
    expect(await bal("CASH")).toBe(D(c0).plus(5000).minus(2000).toFixed(2));
    expect(await bal("BANK")).toBe(D(b0).minus("1200.50").plus(2000).toFixed(2));
  });
  it("rejects bad input with plain messages", async () => {
    await expect(recordReceipt(db, { companyId, userId, date: "2026-08-01", amount: "0", cashBankId: acc.CASH, fromAccountId: acc.OTHER_INCOME })).rejects.toThrow(/greater than zero/);
    await expect(recordReceipt(db, { companyId, userId, date: "2026-08-01", amount: "10.123", cashBankId: acc.CASH, fromAccountId: acc.OTHER_INCOME })).rejects.toThrow(/2 decimals/);
    await expect(recordPayment(db, { companyId, userId, date: "2026-08-01", amount: "10", cashBankId: acc.RENT, toAccountId: acc.CASH })).rejects.toThrow(/cash or bank/);
    await expect(recordContra(db, { companyId, userId, date: "2026-08-01", amount: "10", fromId: acc.CASH, toId: acc.CASH })).rejects.toThrow(/different/);
  });
});

describe("opening balances", () => {
  it("balances through Opening Balance Equity and can be replaced without losing history", async () => {
    const r = await registerOwner(db, { name: "Open", email: `open${Date.now()}@t.in`, password: "secret123", businessName: "Open Co" });
    const cid = r.company.id, uid = r.user.id;
    const bank = await addBankAccount(db, cid, uid, { bankName: "HDFC" });
    const a = Object.fromEntries((await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })).map((x) => [x.systemKey ?? x.id, x.id]));
    await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01",
      balances: { [a.CASH]: "25000", [bank.accountId]: "175000.50", [a.BANK_LOAN]: "100000" } });
    let tb = await trialBalance(db, cid, "2026-04-01");
    expect(tb.balanced).toBe(true);
    const eq_ = tb.rows.find((x) => x.accountId === a.OPENING_BALANCE_EQUITY)!;
    expect(eq_.creditBalance.toFixed(2)).toBe("100000.50"); // 25000 + 175000.50 - 100000

    // replace: bank overdraft of 5000, no loan
    await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [a.CASH]: "25000", [bank.accountId]: "-5000" } });
    tb = await trialBalance(db, cid, "2026-04-01");
    expect(tb.balanced).toBe(true);
    const bankRow = tb.rows.find((x) => x.accountId === bank.accountId)!;
    expect(bankRow.creditBalance.toFixed(2)).toBe("5000.00");
    expect(tb.rows.find((x) => x.accountId === a.BANK_LOAN)!.creditBalance.toFixed(2)).toBe("0.00");
    const opening = await currentOpening(db, cid);
    expect(opening.balances[bank.accountId]).toBe("-5000.00");
    const all = await db.query.journalEntries.findMany({ where: eq(schema.journalEntries.companyId, cid) });
    expect(all.map((e) => `${e.voucherType}:${e.status}`).sort()).toEqual(["OPENING:POSTED", "OPENING:REVERSED", "REVERSAL:POSTED"]);
  });
});

describe("reports", () => {
  it("trial balance always balances and matches money position", async () => {
    const tb = await trialBalance(db, companyId, "2027-12-31");
    expect(tb.balanced).toBe(true);
    const mp = await moneyPosition(db, companyId, "2027-12-31");
    expect(mp.total.toFixed(2)).toBe(D(await bal("CASH", "2027-12-31")).plus(await bal("BANK", "2027-12-31")).toFixed(2));
  });
  it("ledger running balance = opening + movements = trial balance figure", async () => {
    const l = (await accountLedger(db, companyId, acc.CASH, "2026-06-01", "2026-12-31"))!;
    const moves = l.lines.reduce((s, x) => s.plus(x.debit).minus(x.credit), D(0));
    expect(l.closing.toFixed(2)).toBe(l.opening.plus(moves).toFixed(2));
    expect(l.closing.toFixed(2)).toBe(await bal("CASH", "2026-12-31"));
  });
  it("health checks all pass", async () => {
    const h = await ledgerHealth(db, companyId);
    expect(h.every((c) => c.ok)).toBe(true);
  });
});

describe("team management", () => {
  it("owner resets a member's password and can deactivate them; login respects both", async () => {
    const email = `staff${Date.now()}@t.in`;
    const u = await addUser(db, companyId, userId, { name: "Staff", email, password: "first1234", role: "SALESPERSON" });
    await resetUserPassword(db, companyId, userId, u.id, "second1234");
    await expect(authenticate(db, email, "first1234")).rejects.toThrow();
    expect((await authenticate(db, email, "second1234")).companyId).toBe(companyId);
    await setUserActive(db, companyId, userId, u.id, false);
    await expect(authenticate(db, email, "second1234")).rejects.toThrow();
    await expect(setUserActive(db, companyId, userId, userId, false)).rejects.toThrow(/own account/);
  });
});

describe("plain-language defaults", () => {
  it("fills a readable note when none is given", async () => {
    const e = await recordContra(db, { companyId, userId, date: "2026-08-05", amount: "100", fromId: acc.CASH, toId: acc.BANK });
    expect(e.narration).toBe("Moved from Cash in hand to SBI");
    const r = await recordReceipt(db, { companyId, userId, date: "2026-08-05", amount: "1", cashBankId: acc.CASH, fromAccountId: acc.OTHER_INCOME });
    expect(r.narration).toBe("Received: Other income");
  });
});
