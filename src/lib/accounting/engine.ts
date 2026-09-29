/**
 * The posting engine. The ONLY way money enters the ledger.
 * Rules (also enforced by database triggers):
 *  - at least 2 lines; each line is either a debit or a credit, positive, max 2 decimals
 *  - total debits = total credits, exactly (decimal arithmetic, never float)
 *  - accounts must belong to the company and be active
 *  - posting into a closed financial period is refused
 *  - posted entries are never edited or deleted; they are reversed
 */
import { and, eq, inArray, lte, gte, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB, type Tx } from "@/db";
import { D, toDb } from "@/lib/money";
import { audit } from "@/lib/services/audit";
import { UserFacingError } from "@/lib/errors";
import { financialYearFor } from "@/lib/accounting/periods";

export type VoucherType = (typeof schema.voucherTypeEnum.enumValues)[number];

export type LineInput = {
  /** Either accountId or systemKey (e.g. "CASH"). */
  accountId?: string;
  systemKey?: string;
  debit?: Decimal.Value;
  credit?: Decimal.Value;
  narration?: string;
  /** Customer/supplier — required on DEBTORS_CONTROL / CREDITORS_CONTROL. */
  partyId?: string;
};

const PARTY_KEYS: Record<string, "CUSTOMER" | "SUPPLIER"> = {
  DEBTORS_CONTROL: "CUSTOMER", CUSTOMER_ADVANCES: "CUSTOMER", CREDITORS_CONTROL: "SUPPLIER", SUPPLIER_ADVANCES: "SUPPLIER",
};

export type PostInput = {
  companyId: string;
  userId: string;
  voucherType: VoucherType;
  date: string; // YYYY-MM-DD
  narration?: string;
  lines: LineInput[];
  sourceType?: string;
  sourceId?: string;
  reversalOfId?: string;
};

const PREFIX: Record<VoucherType, string> = {
  OPENING: "OPN", JOURNAL: "JV", RECEIPT: "RCT", PAYMENT: "PMT", CONTRA: "CTR", REVERSAL: "REV",
  SALES: "INV", PURCHASE: "PUR", CREDIT_NOTE: "CN", DEBIT_NOTE: "DN", STOCK_ADJUSTMENT: "ADJ",
};

export class LedgerError extends UserFacingError {}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"));

/** Pure validation — no database. Returns normalised lines and total. Exported for tests. */
export function validateLines(lines: LineInput[]) {
  if (!Array.isArray(lines) || lines.length < 2) throw new LedgerError("An entry needs at least two lines (one side receives, one side gives).");
  let dr = D(0), cr = D(0);
  const out = lines.map((l, i) => {
    let d: Decimal, c: Decimal;
    try { d = D(l.debit ?? 0); c = D(l.credit ?? 0); } catch { throw new LedgerError(`Line ${i + 1}: amount is not a valid number.`); }
    if (!d.isFinite() || !c.isFinite()) throw new LedgerError(`Line ${i + 1}: amount is not a valid number.`);
    if (d.isNegative() || c.isNegative()) throw new LedgerError(`Line ${i + 1}: amounts cannot be negative.`);
    if (d.decimalPlaces() > 2 || c.decimalPlaces() > 2) throw new LedgerError(`Line ${i + 1}: amounts can have at most 2 decimal places (paise).`);
    if (d.isZero() === c.isZero()) throw new LedgerError(`Line ${i + 1}: enter either a debit or a credit amount, not both or neither.`);
    if (d.plus(c).gt("9999999999999999.99")) throw new LedgerError(`Line ${i + 1}: amount is too large.`);
    if (!l.accountId && !l.systemKey) throw new LedgerError(`Line ${i + 1}: choose an account.`);
    dr = dr.plus(d); cr = cr.plus(c);
    return { ...l, debit: d, credit: c };
  });
  if (!dr.eq(cr)) throw new LedgerError(`This entry doesn't balance: debits ₹${dr.toFixed(2)} vs credits ₹${cr.toFixed(2)} (difference ₹${dr.minus(cr).abs().toFixed(2)}). Nothing was saved.`);
  return { lines: out, total: dr };
}

/** Finds (or creates) the financial period for a date. Refuses closed periods. */
export async function periodFor(tx: Tx, companyId: string, date: string) {
  const existing = await tx.query.financialPeriods.findFirst({
    where: and(eq(schema.financialPeriods.companyId, companyId),
      lte(schema.financialPeriods.startDate, date), gte(schema.financialPeriods.endDate, date)) });
  if (existing) {
    if (existing.isClosed) throw new LedgerError(`${existing.name} is closed. Entries dated ${date} can't be added. Ask the accountant to reopen it if this is really needed.`);
    return existing;
  }
  const company = await tx.query.companies.findFirst({ where: eq(schema.companies.id, companyId) });
  const fy = financialYearFor(new Date(date + "T00:00:00Z"), company?.financialYearStartMonth ?? 4);
  const [p] = await tx.insert(schema.financialPeriods).values({ companyId, name: fy.name, startDate: fy.start, endDate: fy.end })
    .onConflictDoNothing().returning();
  return p ?? (await tx.query.financialPeriods.findFirst({
    where: and(eq(schema.financialPeriods.companyId, companyId), eq(schema.financialPeriods.startDate, fy.start)) }))!;
}

/** Next gap-free number, e.g. RCT/2026-27/0001. Row lock serialises concurrent posts. */
async function nextVoucherNumber(tx: Tx, companyId: string, type: VoucherType, period: { id: string; name: string }) {
  await tx.insert(schema.voucherSequences).values({ companyId, voucherType: type, periodId: period.id }).onConflictDoNothing();
  const rows = await tx.execute<{ id: string; next_number: number }>(sql`
    SELECT id, next_number FROM voucher_sequences
    WHERE company_id = ${companyId} AND voucher_type = ${type} AND period_id = ${period.id} FOR UPDATE`);
  const row = rows.rows[0];
  await tx.update(schema.voucherSequences).set({ nextNumber: row.next_number + 1 }).where(eq(schema.voucherSequences.id, row.id));
  const fy = period.name.replace(/^FY\s*/, "");
  return `${PREFIX[type]}/${fy}/${String(row.next_number).padStart(4, "0")}`;
}

/** Post inside an existing transaction (so callers like invoicing can post atomically with their own rows). */
export async function postEntryTx(tx: Tx, input: PostInput) {
  if (!isDate(input.date)) throw new LedgerError("Please enter a valid date.");
  const { lines, total } = validateLines(input.lines);

  // Resolve accounts: by id or by system key, all must belong to this company and be active.
  const ids = lines.filter((l) => l.accountId).map((l) => l.accountId!);
  const keys = lines.filter((l) => !l.accountId).map((l) => l.systemKey!);
  const found = [
    ...(ids.length ? await tx.query.accounts.findMany({ where: and(eq(schema.accounts.companyId, input.companyId), inArray(schema.accounts.id, ids)) }) : []),
    ...(keys.length ? await tx.query.accounts.findMany({ where: and(eq(schema.accounts.companyId, input.companyId), inArray(schema.accounts.systemKey, keys)) }) : []),
  ];
  const byId = new Map(found.map((a) => [a.id, a]));
  const byKey = new Map(found.filter((a) => a.systemKey).map((a) => [a.systemKey!, a]));
  const resolved = lines.map((l, i) => {
    const acc = l.accountId ? byId.get(l.accountId) : byKey.get(l.systemKey!);
    if (!acc) throw new LedgerError(`Line ${i + 1}: account not found in this business.`);
    if (!acc.isActive) throw new LedgerError(`Line ${i + 1}: "${acc.ownerLabel}" is inactive.`);
    const needs = acc.systemKey ? PARTY_KEYS[acc.systemKey] : undefined;
    if (l.partyId && !needs) throw new LedgerError(`Line ${i + 1}: a customer/supplier can't be tagged on "${acc.ownerLabel}".`);
    if (!l.partyId && (acc.systemKey === "DEBTORS_CONTROL" || acc.systemKey === "CREDITORS_CONTROL"))
      throw new LedgerError(`Line ${i + 1}: choose which ${needs === "CUSTOMER" ? "customer" : "supplier"} this is for.`);
    return { ...l, account: acc, needs };
  });
  const partyIds = [...new Set(resolved.filter((l) => l.partyId).map((l) => l.partyId!))];
  if (partyIds.length) {
    const ps = await tx.query.parties.findMany({ where: and(eq(schema.parties.companyId, input.companyId), inArray(schema.parties.id, partyIds)) });
    const pm = new Map(ps.map((p) => [p.id, p]));
    resolved.forEach((l, i) => {
      if (!l.partyId) return;
      const p = pm.get(l.partyId);
      if (!p) throw new LedgerError(`Line ${i + 1}: customer/supplier not found in this business.`);
      if (p.type !== l.needs) throw new LedgerError(`Line ${i + 1}: "${l.account.ownerLabel}" needs a ${l.needs === "CUSTOMER" ? "customer" : "supplier"}.`);
    });
  }

  const period = await periodFor(tx, input.companyId, input.date);
  const voucherNumber = await nextVoucherNumber(tx, input.companyId, input.voucherType, period);
  const [entry] = await tx.insert(schema.journalEntries).values({
    companyId: input.companyId, periodId: period.id, voucherType: input.voucherType, voucherNumber,
    entryDate: input.date, narration: input.narration?.trim() || null, totalAmount: toDb(total),
    reversalOfId: input.reversalOfId ?? null, sourceType: input.sourceType ?? "manual", sourceId: input.sourceId ?? null,
    createdBy: input.userId,
  }).returning();
  await tx.insert(schema.journalLines).values(resolved.map((l, i) => ({
    entryId: entry.id, companyId: input.companyId, accountId: l.account.id, lineNo: i + 1, partyId: l.partyId ?? null,
    debit: toDb(l.debit), credit: toDb(l.credit), narration: l.narration?.trim() || null,
  })));
  await audit(tx, { companyId: input.companyId, userId: input.userId, action: "ledger.post", entityType: "journal_entry",
    entityId: entry.id, after: { voucherNumber, type: input.voucherType, date: input.date, total: toDb(total),
      lines: resolved.map((l) => ({ account: l.account.code, party: l.partyId, dr: toDb(l.debit), cr: toDb(l.credit) })) },
    source: input.sourceType === "ai" ? "ai" : "app" });
  return entry;
}

export async function postEntry(db: DB, input: PostInput) {
  return db.transaction((tx) => postEntryTx(tx, input));
}

/** Reverse a posted entry with an equal-and-opposite entry. The original stays visible, marked REVERSED. */
export async function reverseEntry(db: DB, p: { companyId: string; userId: string; entryId: string; reason: string; date?: string }) {
  return db.transaction((tx) => reverseEntryTx(tx, p));
}

/** Same as reverseEntry, inside an existing transaction (used when cancelling invoices/bills). */
export async function reverseEntryTx(tx: Tx, p: { companyId: string; userId: string; entryId: string; reason: string; date?: string }) {
  if (!p.reason?.trim()) throw new LedgerError("Please give a reason.");
  const locked = await tx.execute<{ id: string }>(sql`SELECT id FROM journal_entries WHERE id = ${p.entryId} AND company_id = ${p.companyId} FOR UPDATE`);
  if (!locked.rows.length) throw new LedgerError("Entry not found.");
  const orig = await tx.query.journalEntries.findFirst({ where: eq(schema.journalEntries.id, p.entryId) });
  if (!orig) throw new LedgerError("Entry not found.");
  if (orig.status === "REVERSED") throw new LedgerError(`${orig.voucherNumber} has already been reversed.`);
  if (orig.voucherType === "REVERSAL") throw new LedgerError("A reversal can't itself be reversed. Post a fresh entry instead.");
  const lines = await tx.query.journalLines.findMany({ where: eq(schema.journalLines.entryId, orig.id), orderBy: schema.journalLines.lineNo });
  const rev = await postEntryTx(tx, {
    companyId: p.companyId, userId: p.userId, voucherType: "REVERSAL", date: p.date ?? orig.entryDate,
    narration: `Reversal of ${orig.voucherNumber}: ${p.reason.trim()}`, reversalOfId: orig.id,
    sourceType: orig.sourceType, sourceId: orig.sourceId ?? undefined,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, narration: l.narration ?? undefined, partyId: l.partyId ?? undefined })),
  });
  await tx.update(schema.journalEntries).set({ status: "REVERSED", reversedById: rev.id, reversalReason: p.reason.trim() })
    .where(eq(schema.journalEntries.id, orig.id));
  await audit(tx, { companyId: p.companyId, userId: p.userId, action: "ledger.reverse", entityType: "journal_entry",
    entityId: orig.id, before: { status: "POSTED" }, after: { status: "REVERSED", reversal: rev.voucherNumber }, reason: p.reason.trim() });
  return rev;
}
