/**
 * Owner-friendly voucher entry. Each function turns a simple form ("money came in") into a
 * balanced double-entry posting through the engine. No function here writes ledger rows directly.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { D, toDb } from "@/lib/money";
import { postEntry, postEntryTx, reverseEntry, LedgerError } from "@/lib/accounting/engine";
import { naturalBalance } from "@/lib/accounting/reports";
import { audit } from "./audit";

type Base = { companyId: string; userId: string; date: string; amount: string; narration?: string };

/** Cash and bank ledgers (group codes 1110 / 1120). */
export async function cashBankAccounts(db: DB, companyId: string) {
  const groups = await db.query.accountGroups.findMany({
    where: and(eq(schema.accountGroups.companyId, companyId), inArray(schema.accountGroups.code, ["1110", "1120"])) });
  if (!groups.length) return [];
  return db.query.accounts.findMany({
    where: and(eq(schema.accounts.companyId, companyId), inArray(schema.accounts.groupId, groups.map((g) => g.id)), eq(schema.accounts.isActive, true)),
    orderBy: schema.accounts.code });
}

async function assertCashBank(db: DB, companyId: string, id: string, label: string) {
  const ok = (await cashBankAccounts(db, companyId)).some((a) => a.id === id);
  if (!ok) throw new LedgerError(`Please choose a cash or bank account for "${label}".`, "cashBankId");
}

async function label(db: DB, id: string) {
  return (await db.query.accounts.findFirst({ where: eq(schema.accounts.id, id) }))?.ownerLabel ?? "account";
}
const note = (given: string | undefined, fallback: string) => given?.trim() || fallback;

function amountOrThrow(v: string) {
  const s = (v ?? "").replace(/[,₹\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s) || D(s).lte(0)) throw new LedgerError("Please enter an amount greater than zero (up to 2 decimals).", "amount");
  return s;
}

/** Money in: Dr Cash/Bank, Cr the source (income, capital, loan…). */
export async function recordReceipt(db: DB, p: Base & { cashBankId: string; fromAccountId: string }) {
  const amt = amountOrThrow(p.amount);
  await assertCashBank(db, p.companyId, p.cashBankId, "received into");
  if (p.cashBankId === p.fromAccountId) throw new LedgerError("The money can't come from the same account it goes into.", "fromAccountId");
  return postEntry(db, { companyId: p.companyId, userId: p.userId, voucherType: "RECEIPT", date: p.date,
    narration: note(p.narration, `Received: ${await label(db, p.fromAccountId)}`),
    lines: [{ accountId: p.cashBankId, debit: amt }, { accountId: p.fromAccountId, credit: amt }] });
}

/** Money out: Dr the purpose (expense, drawings, loan repayment…), Cr Cash/Bank. */
export async function recordPayment(db: DB, p: Base & { cashBankId: string; toAccountId: string }) {
  const amt = amountOrThrow(p.amount);
  await assertCashBank(db, p.companyId, p.cashBankId, "paid from");
  if (p.cashBankId === p.toAccountId) throw new LedgerError("Choose what the payment was for.", "toAccountId");
  return postEntry(db, { companyId: p.companyId, userId: p.userId, voucherType: "PAYMENT", date: p.date,
    narration: note(p.narration, `Paid: ${await label(db, p.toAccountId)}`),
    lines: [{ accountId: p.toAccountId, debit: amt }, { accountId: p.cashBankId, credit: amt }] });
}

/** Move money between cash and bank (deposit, withdrawal, transfer). */
export async function recordContra(db: DB, p: Base & { fromId: string; toId: string }) {
  const amt = amountOrThrow(p.amount);
  await assertCashBank(db, p.companyId, p.fromId, "from");
  await assertCashBank(db, p.companyId, p.toId, "to");
  if (p.fromId === p.toId) throw new LedgerError("'From' and 'To' must be different accounts.", "toId");
  return postEntry(db, { companyId: p.companyId, userId: p.userId, voucherType: "CONTRA", date: p.date,
    narration: note(p.narration, `Moved from ${await label(db, p.fromId)} to ${await label(db, p.toId)}`),
    lines: [{ accountId: p.toId, debit: amt }, { accountId: p.fromId, credit: amt }] });
}

export { reverseEntry };

// ───────────── Opening balances ─────────────

export type OpeningInput = {
  companyId: string; userId: string; date: string;
  /** accountId -> balance on the account's normal side. Negative allowed for bank (overdraft). */
  balances: Record<string, string>;
};

/**
 * Posts ONE opening-balance entry. The difference between what the business owns and owes goes to
 * "Opening Balance Equity" (the owner's stake at the start). Re-running replaces the previous opening
 * entry by reversing it — history is kept.
 */
export async function setOpeningBalances(db: DB, p: OpeningInput) {
  return db.transaction(async (tx) => {
    const accs = await tx.query.accounts.findMany({ where: eq(schema.accounts.companyId, p.companyId) });
    const byId = new Map(accs.map((a) => [a.id, a]));
    const equity = accs.find((a) => a.systemKey === "OPENING_BALANCE_EQUITY");
    if (!equity) throw new LedgerError("Opening balance account is missing from the chart of accounts.");

    const lines: { accountId: string; debit?: string; credit?: string }[] = [];
    let net = D(0); // debit minus credit
    for (const [id, raw] of Object.entries(p.balances)) {
      const s = (raw ?? "").replace(/[,₹\s]/g, "");
      if (s === "" || D(s).isZero()) continue;
      if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new LedgerError("Opening amounts must be numbers with up to 2 decimals.");
      const a = byId.get(id);
      if (!a) throw new LedgerError("Unknown account in opening balances.");
      if (a.id === equity.id) continue;
      const v = D(s);
      const debitSide = a.nature === "ASSET" || a.nature === "EXPENSE";
      const isDr = debitSide ? v.gt(0) : v.lt(0);
      const amt = toDb(v.abs());
      lines.push(isDr ? { accountId: id, debit: amt } : { accountId: id, credit: amt });
      net = isDr ? net.plus(amt) : net.minus(amt);
    }

    // Replace previous opening entry, if any, by reversing it.
    const prev = await tx.query.journalEntries.findFirst({
      where: and(eq(schema.journalEntries.companyId, p.companyId), eq(schema.journalEntries.voucherType, "OPENING"), eq(schema.journalEntries.status, "POSTED")) });

    if (!lines.length) {
      if (prev) await reverseInTx(tx, p, prev.id);
      return null;
    }
    if (!net.isZero()) lines.push(net.gt(0) ? { accountId: equity.id, credit: toDb(net) } : { accountId: equity.id, debit: toDb(net.abs()) });
    if (lines.length < 2) throw new LedgerError("Opening balances need at least one amount.");

    if (prev) await reverseInTx(tx, p, prev.id);
    const entry = await postEntryTx(tx, { companyId: p.companyId, userId: p.userId, voucherType: "OPENING", date: p.date,
      narration: "Opening balances", lines, sourceType: "opening" });
    await tx.update(schema.companies).set({ booksBeginOn: p.date, updatedAt: new Date() }).where(eq(schema.companies.id, p.companyId));
    return entry;
  });
}

async function reverseInTx(tx: Parameters<Parameters<DB["transaction"]>[0]>[0], p: { companyId: string; userId: string }, entryId: string) {
  const orig = await tx.query.journalEntries.findFirst({ where: eq(schema.journalEntries.id, entryId) });
  const lines = await tx.query.journalLines.findMany({ where: eq(schema.journalLines.entryId, entryId) });
  const rev = await postEntryTx(tx, { companyId: p.companyId, userId: p.userId, voucherType: "REVERSAL", date: orig!.entryDate,
    narration: `Reversal of ${orig!.voucherNumber}: opening balances updated`, reversalOfId: entryId, sourceType: "opening",
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit })) });
  await tx.update(schema.journalEntries).set({ status: "REVERSED", reversedById: rev.id, reversalReason: "Opening balances updated" })
    .where(eq(schema.journalEntries.id, entryId));
  await audit(tx, { companyId: p.companyId, userId: p.userId, action: "ledger.reverse", entityType: "journal_entry", entityId: entryId,
    reason: "Opening balances updated" });
}

/** Current opening balances per account (from the active OPENING entry), on the natural side. */
export async function currentOpening(db: DB, companyId: string) {
  const e = await db.query.journalEntries.findFirst({
    where: and(eq(schema.journalEntries.companyId, companyId), eq(schema.journalEntries.voucherType, "OPENING"), eq(schema.journalEntries.status, "POSTED")) });
  if (!e) return { entry: null, balances: {} as Record<string, string> };
  const rows = await db.select({ accountId: schema.journalLines.accountId, nature: schema.accounts.nature,
    dr: sql<string>`sum(${schema.journalLines.debit})`, cr: sql<string>`sum(${schema.journalLines.credit})` })
    .from(schema.journalLines).innerJoin(schema.accounts, eq(schema.accounts.id, schema.journalLines.accountId))
    .where(eq(schema.journalLines.entryId, e.id)).groupBy(schema.journalLines.accountId, schema.accounts.nature);
  return { entry: e, balances: Object.fromEntries(rows.map((r) => [r.accountId, naturalBalance(r.nature, r.dr, r.cr).toFixed(2)])) };
}
