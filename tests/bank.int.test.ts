import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import { registerOwner, addBankAccount, updateBusinessInfo } from "@/lib/services/company";
import { createParty, recordCustomerPayment, recordSupplierPayment } from "@/lib/services/parties";
import { recordPayment, reverseEntry, setOpeningBalances } from "@/lib/services/vouchers";
import { parseStatement, readStatementFile, parseBankDate, parseBankAmount } from "@/lib/bank/statement";
import { importStatement, reconciliation, confirmMatch, setBankLineStatus, bankLineOfEntry } from "@/lib/bank/reconcile";

afterAll(async () => { await pool.end(); });

const HDFC = `HDFC BANK Ltd.,,,,,,
Statement of accounts,,,,,,
Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance
02/09/26,UPI-RAMESH TRADERS-ramesh@okaxis-PAYMENT,0000624512,02/09/26,,"25,000.00","1,25,000.00"
03/09/26,NEFT DR-SF SONIC DISTRIBUTORS-INV 101,N245678,03/09/26,"40,000.00",,"85,000.00"
05/09/26,CHQ DEP-MOHAN ELECTRICALS,000123,06/09/26,,"12,000.00","97,000.00"
07/09/26,SMS CHARGES QTR,,07/09/26,17.70,,"96,982.30"
09/09/26,IMPS-RAMESH TRADERS-5000,IMPS77,09/09/26,,"5,000.00","1,01,982.30"
,,,,,,
Opening Balance,Dr Count,Cr Count,Debits,Credits,Closing Bal,
"1,00,000.00",2,3,"40,017.70","42,000.00","1,01,982.30",`;

describe("reading statements", () => {
  it("dates, amounts", () => {
    expect(parseBankDate("02/09/26")).toBe("2026-09-02"); expect(parseBankDate("5-Sep-2026")).toBe("2026-09-05");
    expect(parseBankDate("05 Sep 2026 10:22 AM")).toBe("2026-09-05"); expect(parseBankDate("31/02/2026")).toBeNull();
    expect(parseBankAmount("1,25,000.00")!.toString()).toBe("125000"); expect(parseBankAmount("500.00 Dr")!.toString()).toBe("-500");
    expect(parseBankAmount("")!.toString()).toBe("0"); expect(parseBankAmount("abc")).toBeNull();
  });
  it("HDFC-style CSV: skips title and footer, checks running balance", async () => {
    const p = parseStatement(await readStatementFile(Buffer.from(HDFC), "hdfc.csv"));
    expect(p.lines).toHaveLength(5); expect(p.opening).toBe("100000.00"); expect(p.closing).toBe("101982.30");
    expect(p.balanceBreaks).toEqual([]); expect(p.lines[1]).toMatchObject({ withdrawal: "40000.00", deposit: "0.00", ref: "N245678" });
    expect(p.skipped).toBeGreaterThan(0);
  });
  it("broken balance is reported", () => {
    const t = HDFC.replace('"85,000.00"', '"86,000.00"');
    return readStatementFile(Buffer.from(t), "x.csv").then((tb) => expect(parseStatement(tb).balanceBreaks).toEqual([2, 3]));
  });
  it("SBI-style .xls that is really HTML, newest first, amount + Dr/Cr variant", async () => {
    const html = `<html><table><tr><td>Account Statement</td></tr><tr><th>Txn Date</th><th>Description</th><th>Ref No./Cheque No.</th><th>Amount</th><th>Dr/Cr</th><th>Balance</th></tr>
      <tr><td>10 Sep 2026</td><td>BY TRANSFER-UPI/Sahu</td><td>UPI1</td><td>3,000.00</td><td>CR</td><td>13,000.00</td></tr>
      <tr><td>08 Sep 2026</td><td>TO ATM WDL</td><td></td><td>2,000.00</td><td>DR</td><td>10,000.00</td></tr></table></html>`;
    const p = parseStatement(await readStatementFile(Buffer.from(html), "sbi.xls"));
    expect(p.lines.map((l) => l.date)).toEqual(["2026-09-08", "2026-09-10"]);
    expect(p.opening).toBe("12000.00"); expect(p.balanceBreaks).toEqual([]);
  });
  it("true binary .xls gives a clear instruction, not a crash", async () => {
    await expect(readStatementFile(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0]), "a.xls")).rejects.toThrow(/CSV/);
  });
});

describe("reconciliation", () => {
  let cid = "", uid = "", bank = "", ramesh = "", sonic = "", acc: Record<string, string> = {};
  beforeAll(async () => {
    const r = await registerOwner(db, { name: "BR", email: `br_${Date.now()}@t.in`, password: "secret123", businessName: "BR" });
    cid = r.company.id; uid = r.user.id;
    await updateBusinessInfo(db, cid, uid, { name: "BR", stateCode: "21" });
    bank = (await addBankAccount(db, cid, uid, { bankName: "HDFC" })).accountId;
    acc = Object.fromEntries((await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, cid) })).filter((a) => a.systemKey).map((a) => [a.systemKey!, a.id]));
    await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [bank]: "100000" } });
    ramesh = (await createParty(db, cid, uid, "CUSTOMER", { name: "Ramesh Traders" })).id;
    sonic = (await createParty(db, cid, uid, "SUPPLIER", { name: "SF Sonic Distributors" })).id;
    await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: ramesh, cashBankId: bank, amount: "25000", date: "2026-09-01" }); // booked a day early
    await recordSupplierPayment(db, { companyId: cid, userId: uid, partyId: sonic, cashBankId: bank, amount: "40000", date: "2026-09-03" });
    await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: ramesh, cashBankId: bank, amount: "5000", date: "2026-09-09" });
    await recordPayment(db, { companyId: cid, userId: uid, date: "2026-09-08", amount: "7000", cashBankId: bank, toAccountId: acc.RENT }); // cheque not yet cleared
  });

  it("imports once; a second import of the same file adds nothing", async () => {
    const parsed = parseStatement(await readStatementFile(Buffer.from(HDFC), "hdfc.csv"));
    const a = await importStatement(db, { companyId: cid, userId: uid, accountId: bank, fileName: "hdfc.csv", parsed });
    expect(a.added).toBe(5);
    const b = await importStatement(db, { companyId: cid, userId: uid, accountId: bank, fileName: "hdfc.csv", parsed });
    expect(b.added).toBe(0); expect(b.duplicates).toBe(5);
  });

  it("suggests exact-amount matches with nearby dates; difference fully explained", async () => {
    const r = (await reconciliation(db, cid, bank))!;
    expect(r.suggestions).toHaveLength(3);
    for (const s of r.suggestions) await confirmMatch(db, { companyId: cid, userId: uid, bankLineId: s.bank.id, journalLineId: s.book.id });
    const r2 = (await reconciliation(db, cid, bank))!;
    expect(r2.matched).toBe(3);
    expect(r2.bankOnly.map((b) => b.narration)).toEqual(["CHQ DEP-MOHAN ELECTRICALS", "SMS CHARGES QTR"]);
    expect(r2.bookOnly.map((b) => b.credit.toString())).toEqual(["7000"]);
    expect(r2.bookClose.toString()).toBe("83000"); expect(r2.bankClose!.toString()).toBe("101982.3");
    expect(r2.startDiff!.toString()).toBe("0");
    expect(r2.unexplained!.toString()).toBe("0");
  });

  it("guards: wrong amount refused; same entry can't be used twice; cancelled entry frees the bank line", async () => {
    const r = (await reconciliation(db, cid, bank))!;
    const sms = r.bankOnly.find((b) => b.narration.startsWith("SMS"))!;
    const rent = r.bookOnly[0];
    await expect(confirmMatch(db, { companyId: cid, userId: uid, bankLineId: sms.id, journalLineId: rent.id })).rejects.toThrow(/Amounts don't match/);
    const e = await recordPayment(db, { companyId: cid, userId: uid, date: "2026-09-07", amount: "17.70", cashBankId: bank, toAccountId: acc.BANK_CHARGES });
    const jl = (await bankLineOfEntry(db, e.id, bank))!;
    await confirmMatch(db, { companyId: cid, userId: uid, bankLineId: sms.id, journalLineId: jl });
    const mohan = r.bankOnly.find((b) => b.narration.startsWith("CHQ"))!;
    await expect(confirmMatch(db, { companyId: cid, userId: uid, bankLineId: mohan.id, journalLineId: jl })).rejects.toThrow();
    await reverseEntry(db, { companyId: cid, userId: uid, entryId: e.id, reason: "test" });
    const r3 = (await reconciliation(db, cid, bank))!;
    expect(r3.stale).toBe(1); expect(r3.bankOnly.map((b) => b.id)).toContain(sms.id);
    expect(r3.unexplained!.toString()).toBe("0");
  });

  it("ignore needs a reason and still keeps the proof balanced", async () => {
    const r = (await reconciliation(db, cid, bank))!;
    const mohan = r.bankOnly.find((b) => b.narration.startsWith("CHQ"))!;
    await expect(setBankLineStatus(db, { companyId: cid, userId: uid, bankLineId: mohan.id, status: "IGNORED" })).rejects.toThrow(/why/);
    await setBankLineStatus(db, { companyId: cid, userId: uid, bankLineId: mohan.id, status: "IGNORED", note: "test" });
    const r2 = (await reconciliation(db, cid, bank))!;
    expect(r2.ignored).toHaveLength(1); expect(r2.unexplained!.toString()).toBe("0");
    const n = await db.execute(sql`SELECT count(*)::int n FROM audit_logs WHERE company_id = ${cid} AND action LIKE 'bank.%'`);
    expect((n.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(6);
  });
});
