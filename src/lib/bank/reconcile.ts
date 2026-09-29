/**
 * Bank reconciliation: match each bank-statement line to the entry in your books, find what's in one but
 * not the other, and prove the difference between book balance and bank balance is fully explained.
 * Suggestions are only suggestions — a match is saved when the owner confirms it.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB } from "@/db";
import { D } from "@/lib/money";
import { UserFacingError } from "@/lib/errors";
import { audit } from "@/lib/services/audit";
import type { ParsedStatement } from "./statement";

export async function bankAccountsFor(db: DB, companyId: string) {
  const r = await db.execute<{ id: string; label: string; bank: string | null; last4: string | null }>(sql`
    SELECT a.id, a.owner_label label, b.bank_name bank, b.account_number_last4 last4 FROM accounts a JOIN account_groups g ON g.id = a.group_id
    LEFT JOIN bank_accounts b ON b.account_id = a.id WHERE a.company_id = ${companyId} AND g.code = '1120' AND a.is_active ORDER BY a.code`);
  return r.rows;
}

export async function importStatement(db: DB, p: { companyId: string; userId: string; accountId: string; fileName: string; parsed: ParsedStatement }) {
  if (!(await bankAccountsFor(db, p.companyId)).some((a) => a.id === p.accountId)) throw new UserFacingError("Choose one of your bank accounts.");
  const { lines } = p.parsed;
  return db.transaction(async (tx) => {
    const [st] = await tx.insert(schema.bankStatements).values({ companyId: p.companyId, accountId: p.accountId, fileName: p.fileName.slice(0, 200),
      fromDate: lines[0].date, toDate: lines[lines.length - 1].date, openingBalance: p.parsed.opening, closingBalance: p.parsed.closing,
      lineCount: lines.length, skipped: p.parsed.skipped, createdBy: p.userId }).returning();
    const seen = new Map<string, number>();
    let added = 0;
    for (const [i, l] of lines.entries()) {
      const base = [l.date, l.withdrawal, l.deposit, l.narration.toLowerCase(), l.balance ?? ""].join("|");
      const n = (seen.get(base) ?? 0) + 1; seen.set(base, n);
      const fingerprint = createHash("sha256").update(`${base}|${n}`).digest("hex").slice(0, 32);
      const r = await tx.insert(schema.bankStatementLines).values({ statementId: st.id, companyId: p.companyId, accountId: p.accountId, lineNo: i + 1,
        txnDate: l.date, narration: l.narration.slice(0, 500), ref: l.ref?.slice(0, 100), withdrawal: l.withdrawal, deposit: l.deposit, balance: l.balance, fingerprint })
        .onConflictDoNothing().returning({ id: schema.bankStatementLines.id });
      added += r.length;
    }
    await audit(tx, { companyId: p.companyId, userId: p.userId, action: "bank.import", entityType: "bank_statement", entityId: st.id, after: { file: p.fileName, lines: lines.length, added } });
    return { statement: st, added, duplicates: lines.length - added };
  });
}

type BankLine = { id: string; date: string; narration: string; ref: string | null; withdrawal: Decimal; deposit: Decimal; balance: Decimal | null; status: string; matchedLineId: string | null; stale: boolean; note: string | null };
type BookLine = { id: string; entryId: string; date: string; voucher: string; narration: string | null; debit: Decimal; credit: Decimal; party: string | null };

/** Book lines on this bank account from live (not cancelled) entries. */
async function bookLines(db: DB, companyId: string, accountId: string, to: string) {
  const r = await db.execute<{ id: string; entry_id: string; d: string; v: string; nar: string | null; debit: string; credit: string; party: string | null }>(sql`
    SELECT l.id, e.id entry_id, e.entry_date d, e.voucher_number v, e.narration nar, l.debit, l.credit,
      (SELECT p.name FROM journal_lines l2 JOIN parties p ON p.id = l2.party_id WHERE l2.entry_id = e.id LIMIT 1) party
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.company_id = ${companyId} AND l.account_id = ${accountId} AND e.status = 'POSTED' AND e.reversal_of_id IS NULL AND e.entry_date <= ${to}
    ORDER BY e.entry_date, e.voucher_number`);
  return r.rows.map((x): BookLine => ({ id: x.id, entryId: x.entry_id, date: x.d, voucher: x.v, narration: x.nar, debit: D(x.debit), credit: D(x.credit), party: x.party }));
}

async function bankLines(db: DB, companyId: string, accountId: string, to = "9999-12-31") {
  const r = await db.execute<{ id: string; d: string; nar: string; ref: string | null; w: string; dep: string; bal: string | null; status: string; m: string | null; live: boolean | null; note: string | null }>(sql`
    SELECT b.id, b.txn_date d, b.narration nar, b.ref, b.withdrawal w, b.deposit dep, b.balance bal, b.status, b.matched_line_id m, b.note,
      (e.status = 'POSTED') live
    FROM bank_statement_lines b LEFT JOIN journal_lines l ON l.id = b.matched_line_id LEFT JOIN journal_entries e ON e.id = l.entry_id
    WHERE b.company_id = ${companyId} AND b.account_id = ${accountId} AND b.txn_date <= ${to}
    ORDER BY b.txn_date, b.statement_id, b.line_no`);
  return r.rows.map((x): BankLine => {
    const stale = x.status === "MATCHED" && !x.live;
    return { id: x.id, date: x.d, narration: x.nar, ref: x.ref, withdrawal: D(x.w), deposit: D(x.dep), balance: x.bal == null ? null : D(x.bal),
      status: stale ? "UNMATCHED" : x.status, matchedLineId: stale ? null : x.m, stale, note: x.note };
  });
}

const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);

/** Suggest a book line for each unmatched bank line: same amount, same direction, dated up to 7 days before (or 2 after) the bank date. */
export function suggest(bank: BankLine[], book: BookLine[]) {
  const used = new Set(bank.filter((b) => b.matchedLineId).map((b) => b.matchedLineId!));
  const pairs: { bank: string; book: string; score: number; gap: number }[] = [];
  for (const b of bank.filter((x) => x.status === "UNMATCHED")) {
    const amt = b.deposit.gt(0) ? b.deposit : b.withdrawal;
    const nar = new Set(tokens(`${b.narration} ${b.ref ?? ""}`));
    for (const k of book) {
      if (used.has(k.id)) continue;
      if (!(b.deposit.gt(0) ? k.debit.eq(amt) : k.credit.eq(amt))) continue;
      const gap = days(k.date, b.date);
      if (gap < -2 || gap > 7) continue;
      const nameHit = tokens(`${k.party ?? ""} ${k.narration ?? ""}`).some((w) => nar.has(w));
      pairs.push({ bank: b.id, book: k.id, gap, score: 10 - Math.abs(gap) + (nameHit ? 5 : 0) });
    }
  }
  // Best pairs first; each bank line and each book line is used once.
  pairs.sort((a, b) => b.score - a.score);
  const takenBank = new Set<string>(), takenBook = new Set<string>(), out = new Map<string, { book: string; sure: boolean }>();
  for (const p of pairs) {
    if (takenBank.has(p.bank) || takenBook.has(p.book)) continue;
    const rivals = pairs.filter((x) => x.bank === p.bank && x.book !== p.book && !takenBook.has(x.book) && x.score >= p.score - 1).length
      + pairs.filter((x) => x.book === p.book && x.bank !== p.bank && !takenBank.has(x.bank) && x.score >= p.score - 1).length;
    takenBank.add(p.bank); takenBook.add(p.book);
    out.set(p.bank, { book: p.book, sure: rivals === 0 && Math.abs(p.gap) <= 3 });
  }
  return out;
}

export async function reconciliation(db: DB, companyId: string, accountId: string, asOf?: string) {
  const stmts = await db.query.bankStatements.findMany({ where: and(eq(schema.bankStatements.companyId, companyId), eq(schema.bankStatements.accountId, accountId)), orderBy: schema.bankStatements.fromDate });
  const allBank = await bankLines(db, companyId, accountId);
  if (!allBank.length) return null;
  const start = allBank[0].date, to = asOf ?? allBank[allBank.length - 1].date;
  const bank = allBank.filter((b) => b.date <= to);
  const book = await bookLines(db, companyId, accountId, to);
  const matchedIds = new Set(bank.filter((b) => b.matchedLineId).map((b) => b.matchedLineId!));
  // Book lines belong to the statement period if dated inside it or matched to a bank line in it (a payment booked a day early).
  const inPeriod = (k: BookLine) => k.date >= start || matchedIds.has(k.id);
  const bookBefore = book.filter((k) => !inPeriod(k)).reduce((s, k) => s.plus(k.debit).minus(k.credit), D(0));
  const bookClose = book.reduce((s, k) => s.plus(k.debit).minus(k.credit), D(0));
  const bookOnly = book.filter((k) => inPeriod(k) && !matchedIds.has(k.id));
  const bankOnly = bank.filter((b) => b.status === "UNMATCHED");
  const ignored = bank.filter((b) => b.status === "IGNORED");
  const firstStmt = stmts.find((s) => s.fromDate === start) ?? stmts[0];
  const bankOpening = firstStmt?.openingBalance != null ? D(firstStmt.openingBalance) : null;
  const lastWithBal = [...bank].reverse().find((b) => b.balance != null);
  const bankClose = lastWithBal && lastWithBal.date === bank[bank.length - 1]?.date ? lastWithBal.balance : null;
  const net = (xs: BankLine[]) => xs.reduce((s, b) => s.plus(b.deposit).minus(b.withdrawal), D(0));
  const bookNet = bookOnly.reduce((s, k) => s.plus(k.debit).minus(k.credit), D(0));
  // bank close = book close − (in books, not yet in bank) + (in bank, not yet in books) + (lines you marked 'ignore') + (difference already there at the start)
  const startDiff = bankOpening ? bankOpening.minus(bookBefore) : null;
  const explained = startDiff != null ? bookClose.minus(bookNet).plus(net(bankOnly)).plus(net(ignored)).plus(startDiff) : null;
  const unexplained = bankClose && explained ? bankClose.minus(explained) : null;
  const sugg = suggest(bank, book);
  const bookById = new Map(book.map((k) => [k.id, k]));
  return { start, to, statements: stmts, bank, bankOnly, ignored, bookOnly, bookBefore, bookClose, bankOpening, bankClose, startDiff, unexplained,
    matched: bank.filter((b) => b.status === "MATCHED").length, stale: bank.filter((b) => b.stale).length,
    suggestions: [...sugg.entries()].map(([b, s]) => ({ bank: bank.find((x) => x.id === b)!, book: bookById.get(s.book)!, sure: s.sure })) };
}

export async function confirmMatch(db: DB, p: { companyId: string; userId: string; bankLineId: string; journalLineId: string }) {
  return db.transaction(async (tx) => {
    const r = await tx.execute<{ w: string; dep: string; acc: string; status: string; m: string | null; live: boolean | null }>(sql`
      SELECT b.withdrawal w, b.deposit dep, b.account_id acc, b.status, b.matched_line_id m, (e.status = 'POSTED') live
      FROM bank_statement_lines b LEFT JOIN journal_lines ml ON ml.id = b.matched_line_id LEFT JOIN journal_entries e ON e.id = ml.entry_id
      WHERE b.id = ${p.bankLineId} AND b.company_id = ${p.companyId} FOR UPDATE OF b`);
    const b = r.rows[0];
    if (!b) throw new UserFacingError("Bank line not found.");
    if (b.status === "MATCHED" && b.live) throw new UserFacingError("This bank line is already matched.");
    const k = await tx.execute<{ debit: string; credit: string; acc: string; status: string; rev: string | null }>(sql`
      SELECT l.debit, l.credit, l.account_id acc, e.status, e.reversal_of_id rev FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.id = ${p.journalLineId} AND l.company_id = ${p.companyId}`);
    const j = k.rows[0];
    if (!j || j.acc !== b.acc) throw new UserFacingError("That entry isn't on this bank account.");
    if (j.status !== "POSTED" || j.rev) throw new UserFacingError("That entry was cancelled.");
    const ok = D(b.dep).gt(0) ? D(j.debit).eq(b.dep) : D(j.credit).eq(b.w);
    if (!ok) throw new UserFacingError("Amounts don't match — a bank line can only be matched to an entry of the same amount and direction.");
    // A stale match (its entry was cancelled) is cleared first.
    await tx.update(schema.bankStatementLines).set({ matchedLineId: null }).where(eq(schema.bankStatementLines.id, p.bankLineId));
    const taken = await tx.execute(sql`SELECT 1 FROM bank_statement_lines WHERE matched_line_id = ${p.journalLineId}`);
    if (taken.rows.length) throw new UserFacingError("That entry is already matched to another bank line.");
    await tx.update(schema.bankStatementLines).set({ status: "MATCHED", matchedLineId: p.journalLineId, matchedBy: p.userId, matchedAt: new Date(), note: null })
      .where(eq(schema.bankStatementLines.id, p.bankLineId));
    await audit(tx, { companyId: p.companyId, userId: p.userId, action: "bank.match", entityType: "bank_line", entityId: p.bankLineId, after: { journalLineId: p.journalLineId } });
  });
}

export async function setBankLineStatus(db: DB, p: { companyId: string; userId: string; bankLineId: string; status: "UNMATCHED" | "IGNORED"; note?: string }) {
  if (p.status === "IGNORED" && !p.note?.trim()) throw new UserFacingError("Say why this bank line should be left out (e.g. 'bank reversed it the same day').");
  const r = await db.update(schema.bankStatementLines).set({ status: p.status, matchedLineId: null, matchedBy: p.userId, matchedAt: new Date(), note: p.note?.trim() || null })
    .where(and(eq(schema.bankStatementLines.id, p.bankLineId), eq(schema.bankStatementLines.companyId, p.companyId))).returning({ id: schema.bankStatementLines.id });
  if (!r.length) throw new UserFacingError("Bank line not found.");
  await audit(db, { companyId: p.companyId, userId: p.userId, action: p.status === "IGNORED" ? "bank.ignore" : "bank.unmatch", entityType: "bank_line", entityId: p.bankLineId, reason: p.note });
}

/** The line on the bank account inside a freshly posted entry — used to match an entry created from a bank line. */
export async function bankLineOfEntry(db: DB, entryId: string, accountId: string) {
  const r = await db.execute<{ id: string }>(sql`SELECT id FROM journal_lines WHERE entry_id = ${entryId} AND account_id = ${accountId} LIMIT 1`);
  return r.rows[0]?.id ?? null;
}
