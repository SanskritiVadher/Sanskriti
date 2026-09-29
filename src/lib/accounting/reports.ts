/**
 * Read-side of the ledger. Every figure here is computed from journal_lines — nothing is stored
 * separately, so reports can never drift from the books.
 */
import { and, asc, eq, lt, lte, gte, sql, desc } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB } from "@/db";
import { D, formatINR } from "@/lib/money";

type Nature = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
/** Assets and expenses normally carry a debit balance; the rest a credit balance. */
export const isDebitNature = (n: Nature) => n === "ASSET" || n === "EXPENSE";

/** Balance expressed on the account's normal side: positive = normal, negative = unusual (e.g. overdraft). */
export const naturalBalance = (n: Nature, dr: Decimal.Value, cr: Decimal.Value) =>
  isDebitNature(n) ? D(dr).minus(cr) : D(cr).minus(dr);

export type TrialBalanceRow = {
  accountId: string; code: string; name: string; ownerLabel: string; nature: Nature;
  groupId: string; groupName: string; groupOwnerLabel: string;
  totalDebit: Decimal; totalCredit: Decimal; debitBalance: Decimal; creditBalance: Decimal;
};

export async function trialBalance(db: DB, companyId: string, asOf: string) {
  const rows = await db.execute<{
    id: string; code: string; name: string; owner_label: string; nature: Nature; group_id: string;
    group_name: string; group_owner_label: string; dr: string; cr: string;
  }>(sql`
    SELECT a.id, a.code, a.name, a.owner_label, a.nature, g.id AS group_id, g.name AS group_name,
           g.owner_label AS group_owner_label,
           coalesce(sum(l.debit), 0) AS dr, coalesce(sum(l.credit), 0) AS cr
    FROM accounts a
    JOIN account_groups g ON g.id = a.group_id
    LEFT JOIN journal_lines l ON l.account_id = a.id
      AND l.entry_id IN (SELECT id FROM journal_entries WHERE company_id = ${companyId} AND entry_date <= ${asOf})
    WHERE a.company_id = ${companyId}
    GROUP BY a.id, g.id
    ORDER BY a.code`);
  const out: TrialBalanceRow[] = rows.rows.map((r) => {
    const net = D(r.dr).minus(r.cr);
    return {
      accountId: r.id, code: r.code, name: r.name, ownerLabel: r.owner_label, nature: r.nature,
      groupId: r.group_id, groupName: r.group_name, groupOwnerLabel: r.group_owner_label,
      totalDebit: D(r.dr), totalCredit: D(r.cr),
      debitBalance: net.gt(0) ? net : D(0), creditBalance: net.lt(0) ? net.neg() : D(0),
    };
  });
  const totalDebit = out.reduce((s, r) => s.plus(r.debitBalance), D(0));
  const totalCredit = out.reduce((s, r) => s.plus(r.creditBalance), D(0));
  return { rows: out, totalDebit, totalCredit, balanced: totalDebit.eq(totalCredit), asOf };
}

export async function accountLedger(db: DB, companyId: string, accountId: string, from: string, to: string) {
  const account = await db.query.accounts.findFirst({
    where: and(eq(schema.accounts.id, accountId), eq(schema.accounts.companyId, companyId)) });
  if (!account) return null;
  const [open] = await db.select({
    dr: sql<string>`coalesce(sum(${schema.journalLines.debit}),0)`, cr: sql<string>`coalesce(sum(${schema.journalLines.credit}),0)`,
  }).from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(eq(schema.journalLines.accountId, accountId), lt(schema.journalEntries.entryDate, from)));
  const opening = naturalBalance(account.nature, open.dr, open.cr);

  const rows = await db.select({
    lineId: schema.journalLines.id, entryId: schema.journalEntries.id, date: schema.journalEntries.entryDate,
    voucherNumber: schema.journalEntries.voucherNumber, voucherType: schema.journalEntries.voucherType,
    status: schema.journalEntries.status, narration: schema.journalEntries.narration,
    lineNarration: schema.journalLines.narration, debit: schema.journalLines.debit, credit: schema.journalLines.credit,
  }).from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(eq(schema.journalLines.accountId, accountId), gte(schema.journalEntries.entryDate, from), lte(schema.journalEntries.entryDate, to)))
    .orderBy(asc(schema.journalEntries.entryDate), asc(schema.journalEntries.createdAt), asc(schema.journalLines.lineNo));

  let running = opening;
  const lines = rows.map((r) => {
    running = running.plus(naturalBalance(account.nature, r.debit, r.credit));
    return { ...r, debit: D(r.debit), credit: D(r.credit), balance: running };
  });
  const totalDebit = lines.reduce((s, l) => s.plus(l.debit), D(0));
  const totalCredit = lines.reduce((s, l) => s.plus(l.credit), D(0));
  return { account, from, to, opening, closing: running, lines, totalDebit, totalCredit };
}

export async function dayBook(db: DB, companyId: string, from: string, to: string, limit = 200) {
  const entries = await db.query.journalEntries.findMany({
    where: and(eq(schema.journalEntries.companyId, companyId), gte(schema.journalEntries.entryDate, from), lte(schema.journalEntries.entryDate, to)),
    orderBy: [desc(schema.journalEntries.entryDate), desc(schema.journalEntries.createdAt)], limit,
  });
  return entries;
}

export async function entryDetail(db: DB, companyId: string, entryId: string) {
  const entry = await db.query.journalEntries.findFirst({
    where: and(eq(schema.journalEntries.id, entryId), eq(schema.journalEntries.companyId, companyId)) });
  if (!entry) return null;
  const lines = await db.select({
    id: schema.journalLines.id, lineNo: schema.journalLines.lineNo, debit: schema.journalLines.debit, credit: schema.journalLines.credit,
    narration: schema.journalLines.narration, accountId: schema.accounts.id, code: schema.accounts.code,
    name: schema.accounts.name, ownerLabel: schema.accounts.ownerLabel,
  }).from(schema.journalLines).innerJoin(schema.accounts, eq(schema.accounts.id, schema.journalLines.accountId))
    .where(eq(schema.journalLines.entryId, entryId)).orderBy(asc(schema.journalLines.lineNo));
  const creator = await db.query.users.findFirst({ where: eq(schema.users.id, entry.createdBy) });
  const related = entry.reversedById ?? entry.reversalOfId;
  const relatedEntry = related ? await db.query.journalEntries.findFirst({ where: eq(schema.journalEntries.id, related) }) : null;
  return { entry, lines, createdByName: creator?.name ?? "Unknown", relatedEntry };
}

/** Cash + bank position right now, per account. */
export async function moneyPosition(db: DB, companyId: string, asOf: string) {
  const tb = await trialBalance(db, companyId, asOf);
  const cashBank = tb.rows.filter((r) => r.code.startsWith("111") || r.code.startsWith("112"));
  const accounts = cashBank.map((r) => ({ ...r, balance: naturalBalance(r.nature, r.totalDebit, r.totalCredit) }));
  return { accounts, total: accounts.reduce((s, a) => s.plus(a.balance), D(0)) };
}

/** Integrity checks for the System Health page. Each returns PASS/ERROR with a plain explanation. */
export async function ledgerHealth(db: DB, companyId: string) {
  const unbalanced = await db.execute<{ voucher_number: string }>(sql`
    SELECT e.voucher_number FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
    WHERE e.company_id = ${companyId} GROUP BY e.id
    HAVING sum(l.debit) <> sum(l.credit) OR sum(l.debit) <> e.total_amount OR count(*) < 2`);
  const orphan = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM journal_entries e WHERE e.company_id = ${companyId}
    AND NOT EXISTS (SELECT 1 FROM journal_lines l WHERE l.entry_id = e.id)`);
  const today = new Date().toISOString().slice(0, 10);
  const tb = await trialBalance(db, companyId, "9999-12-31");
  const badReversals = await db.execute<{ voucher_number: string }>(sql`
    SELECT e.voucher_number FROM journal_entries e WHERE e.company_id = ${companyId} AND e.status = 'REVERSED'
    AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.id = e.reversed_by_id AND r.reversal_of_id = e.id)`);
  const inv = await db.execute<{ stock: string; ledger: string }>(sql`
    SELECT (SELECT coalesce(sum(value),0) FROM inventory_transactions WHERE company_id = ${companyId}) AS stock,
           (SELECT coalesce(sum(l.debit - l.credit),0) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
             WHERE l.company_id = ${companyId} AND a.system_key = 'INVENTORY') AS ledger`);
  const stockV = D(inv.rows[0].stock), ledgerV = D(inv.rows[0].ledger);
  const partyChk = await db.execute<{ k: string; total: string; tagged: string }>(sql`
    SELECT a.system_key AS k, coalesce(sum(l.debit - l.credit),0) AS total,
           coalesce(sum(CASE WHEN l.party_id IS NOT NULL THEN l.debit - l.credit ELSE 0 END),0) AS tagged
    FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
    WHERE a.company_id = ${companyId} AND a.system_key IN ('DEBTORS_CONTROL','CREDITORS_CONTROL') GROUP BY a.system_key`);
  const partyOk = partyChk.rows.every((r) => D(r.total).eq(r.tagged));
  const negStock = await db.execute<{ name: string }>(sql`
    SELECT p.name FROM products p JOIN inventory_transactions t ON t.product_id = p.id
    WHERE p.company_id = ${companyId} GROUP BY p.id HAVING sum(t.quantity) < 0`);
  const { gstReconciliation } = await import("@/lib/services/gst");
  const g = await gstReconciliation(db, companyId);
  return [
    { name: "GST in the books matches bills and invoices", ok: g.ok,
      detail: g.ok ? `GST collected ${formatINR(g.docsOut)} and GST paid on purchases ${formatINR(g.docsIn)} agree with the accounts.`
        : `Documents: collected ${formatINR(g.docsOut)}, paid ${formatINR(g.docsIn)}. Accounts: ${formatINR(g.ledgerOut)} / ${formatINR(g.ledgerIn)}. A manual entry may have touched a GST account.` },
    { name: "Stock value matches the books", ok: stockV.eq(ledgerV),
      detail: stockV.eq(ledgerV) ? `Stock on hand is worth ${formatINR(stockV)}, same as in the accounts.` : `Stock records say ${formatINR(stockV)} but accounts say ${formatINR(ledgerV)}.` },
    { name: "No product below zero", ok: negStock.rows.length === 0,
      detail: negStock.rows.length ? `Below zero: ${negStock.rows.map((r) => r.name).join(", ")}` : "Every product has zero or more in stock." },
    { name: "Customer & supplier dues add up", ok: partyOk,
      detail: partyOk ? "Each customer's and supplier's balance adds up to the totals in the accounts." : "Some dues are not linked to a customer/supplier." },
    { name: "Every entry balances", ok: unbalanced.rows.length === 0,
      detail: unbalanced.rows.length ? `Unbalanced: ${unbalanced.rows.map((r) => r.voucher_number).join(", ")}` : "Debits equal credits in every entry." },
    { name: "No empty entries", ok: orphan.rows[0].n === 0, detail: orphan.rows[0].n ? `${orphan.rows[0].n} entries have no lines.` : "Every entry has its lines." },
    { name: "Trial balance agrees", ok: tb.balanced,
      detail: tb.balanced ? `Total debits = total credits = ${formatINR(tb.totalDebit)}.` : `Debits ${formatINR(tb.totalDebit)} vs credits ${formatINR(tb.totalCredit)}.` },
    { name: "Reversals are linked", ok: badReversals.rows.length === 0,
      detail: badReversals.rows.length ? `Check: ${badReversals.rows.map((r) => r.voucher_number).join(", ")}` : "Every reversed entry points to its reversal." },
  ].map((c) => ({ ...c, checkedAt: today }));
}
