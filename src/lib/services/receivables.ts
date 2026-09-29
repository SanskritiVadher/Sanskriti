/**
 * Who owes what, since when. Computed from the ledger, never stored:
 * - every amount billed to a party (invoice, opening balance) is an "open item" with a due date
 * - every amount received (payment, credit) pays off the OLDEST open item first (FIFO)
 * - cancelled entries and their reversals are left out entirely, so they don't pay off unrelated bills
 * The same logic serves suppliers (bills we owe) with the sides flipped.
 */
import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB } from "@/db";
import { D } from "@/lib/money";
import { todayIST } from "@/lib/dates";

const days = (a: string, b: string) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000);

/** Old balances brought in at setup have no known bill dates, so their age is unknown — never invented. */
export type OpenItem = { entryId: string; docId: string | null; number: string; date: string; dueDate: string; amount: Decimal; open: Decimal; daysOverdue: number; ageUnknown: boolean; settledOn: string | null; kind: "INVOICE" | "BILL" | "OPENING" | "OTHER" };

type Row = { party_id: string; entry_id: string; date: string; created_at: string; vnum: string; source_type: string; dr: string; cr: string;
  inv_id: string | null; inv_due: string | null; inv_no: string | null; bill_id: string | null; bill_due: string | null; bill_no: string | null; target: string | null };

/** One query for one party or for every party of a type (ageing) — no per-party round trips. */
async function openRows(db: DB, companyId: string, asOf: string, filter: { partyId: string } | { type: "CUSTOMER" | "SUPPLIER" }) {
  const where = "partyId" in filter ? sql`l.party_id = ${filter.partyId}` : sql`l.party_id IN (SELECT id FROM parties WHERE company_id = ${companyId} AND type = ${filter.type})`;
  // `target` = the document a credit belongs to (a return or a payment made with that bill), settled first.
  const rows = await db.execute<Row>(sql`
    SELECT l.party_id, e.id AS entry_id, e.entry_date AS date, e.created_at, e.voucher_number AS vnum, e.source_type,
      sum(l.debit) AS dr, sum(l.credit) AS cr,
      si.id AS inv_id, si.due_date AS inv_due, si.number AS inv_no, pb.id AS bill_id, pb.due_date AS bill_due, pb.bill_number AS bill_no,
      coalesce(gn.invoice_id, gn.bill_id,
        CASE WHEN e.source_type IN ('sales_payment','purchase_payment') THEN e.source_id::uuid END) AS target
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
    LEFT JOIN sales_invoices si ON si.entry_id = e.id
    LEFT JOIN purchase_bills pb ON pb.entry_id = e.id
    LEFT JOIN gst_notes gn ON gn.entry_id = e.id
    WHERE l.company_id = ${companyId} AND ${where} AND e.status = 'POSTED' AND e.reversal_of_id IS NULL AND e.entry_date <= ${asOf}
    GROUP BY l.party_id, e.id, si.id, pb.id, gn.id ORDER BY e.entry_date, e.created_at`);
  return rows.rows;
}

export async function openItems(db: DB, companyId: string, partyId: string, asOf = todayIST()) {
  const party = await db.query.parties.findFirst({ where: and(eq(schema.parties.id, partyId), eq(schema.parties.companyId, companyId)) });
  if (!party) return null;
  return settle(party, await openRows(db, companyId, asOf, { partyId }), asOf);
}

type PartyRow = typeof schema.parties.$inferSelect;
function settle(party: PartyRow, rows: Row[], asOf: string) {
  const C = party.type === "CUSTOMER";
  // For customers, debits raise what they owe; for suppliers, credits raise what we owe.
  const items: OpenItem[] = [];
  const credits: { date: string; amount: Decimal; target: string | null }[] = [];
  for (const r of rows) {
    const up = D(C ? r.dr : r.cr).minus(C ? r.cr : r.dr);
    if (up.gt(0)) {
      const kind = r.inv_id ? "INVOICE" : r.bill_id ? "BILL" : r.source_type === "opening_party" ? "OPENING" : "OTHER";
      items.push({ entryId: r.entry_id, docId: r.inv_id ?? r.bill_id, number: r.inv_no ?? (r.bill_no ? `Bill ${r.bill_no}` : kind === "OPENING" ? "Old balance" : r.vnum),
        date: r.date, dueDate: r.inv_due ?? r.bill_due ?? r.date, amount: up, open: up, daysOverdue: 0, ageUnknown: kind === "OPENING", settledOn: null, kind });
    } else if (up.lt(0)) credits.push({ date: r.date, amount: up.neg(), target: r.target });
  }
  // FIFO: each credit (in date order) pays the oldest open items.
  let advance = D(0);
  for (const c of credits) {
    let left = c.amount;
    const own = c.target ? items.filter((i) => i.docId === c.target) : [];
    for (const it of [...own, ...items.filter((i) => !own.includes(i))]) {
      if (left.lte(0)) break;
      if (it.open.lte(0)) continue;
      const take = Decimal.min(left, it.open);
      it.open = it.open.minus(take); left = left.minus(take);
      if (it.open.isZero()) it.settledOn = c.date > it.date ? c.date : it.date;
    }
    advance = advance.plus(left);
  }
  for (const it of items) it.daysOverdue = it.open.gt(0) && !it.ageUnknown ? Math.max(0, days(asOf, it.dueDate)) : 0;
  const open = items.filter((i) => i.open.gt(0));
  const outstanding = open.reduce((s, i) => s.plus(i.open), D(0)).minus(advance);
  const overdueItems = open.filter((i) => i.daysOverdue > 0);
  const overdue = overdueItems.reduce((s, i) => s.plus(i.open), D(0));
  const oldBalance = open.filter((i) => i.ageUnknown).reduce((s, i) => s.plus(i.open), D(0));

  // Payment habit: how late settled invoices/bills were paid (needs at least 3 to say anything).
  const settled = items.filter((i) => i.settledOn && (i.kind === "INVOICE" || i.kind === "BILL"));
  const lateness = settled.map((i) => days(i.settledOn!, i.dueDate));
  const habit = lateness.length >= 3 ? { count: lateness.length, avgDaysLate: Math.round(lateness.reduce((a, b) => a + b, 0) / lateness.length),
    onTime: lateness.filter((d) => d <= 0).length } : null;
  return { party, items, open, advance, outstanding, overdue, overdueItems, oldBalance,
    oldestOverdueDays: overdueItems.length ? Math.max(...overdueItems.map((i) => i.daysOverdue)) : 0,
    dueSoon: open.filter((i) => !i.ageUnknown && i.daysOverdue === 0 && days(i.dueDate, asOf) <= 7).reduce((s, i) => s.plus(i.open), D(0)), habit };
}

/** Lightweight version used by billing's credit check. */
export async function receivablesFor(db: DB, companyId: string, partyId: string, asOf = todayIST()) {
  const r = await openItems(db, companyId, partyId, asOf);
  return { overdue: r?.overdue ?? D(0), oldestOverdueDays: r?.oldestOverdueDays ?? 0 };
}

export type Bucket = "notDue" | "d1_30" | "d31_60" | "d61_90" | "d90" | "old";
/** Company-wide ageing + a "call these first" ranking (amount overdue weighted by how late). */
export async function ageing(db: DB, companyId: string, type: "CUSTOMER" | "SUPPLIER", asOf = todayIST()) {
  const [plist, rows] = await Promise.all([
    db.query.parties.findMany({ where: and(eq(schema.parties.companyId, companyId), eq(schema.parties.type, type)) }),
    openRows(db, companyId, asOf, { type })]);
  const byParty = new Map<string, Row[]>();
  for (const r of rows) (byParty.get(r.party_id) ?? byParty.set(r.party_id, []).get(r.party_id)!).push(r);
  const pmap = new Map(plist.map((p) => [p.id, p]));
  const buckets: Record<Bucket, Decimal> = { notDue: D(0), d1_30: D(0), d31_60: D(0), d61_90: D(0), d90: D(0), old: D(0) };
  const parties: { id: string; name: string; phone: string | null; whatsapp: string | null; outstanding: Decimal; overdue: Decimal; oldBalance: Decimal; oldest: number; score: Decimal; habit: { avgDaysLate: number } | null; dueSoon: Decimal }[] = [];
  for (const [pid, prow] of byParty) {
    const r = settle(pmap.get(pid)!, prow, asOf);
    for (const i of r.open) {
      const b: Bucket = i.ageUnknown ? "old" : i.daysOverdue === 0 ? "notDue" : i.daysOverdue <= 30 ? "d1_30" : i.daysOverdue <= 60 ? "d31_60" : i.daysOverdue <= 90 ? "d61_90" : "d90";
      buckets[b] = buckets[b].plus(i.open);
    }
    if (r.outstanding.gt(0)) parties.push({ id: r.party.id, name: r.party.name, phone: r.party.phone, whatsapp: r.party.whatsapp,
      outstanding: r.outstanding, overdue: r.overdue, oldBalance: r.oldBalance, oldest: r.oldestOverdueDays, habit: r.habit, dueSoon: r.dueSoon,
      // Old balances count as "should be collected" at a neutral weight (their age is unknown).
      score: r.overdueItems.reduce((s, i) => s.plus(i.open.mul(1 + i.daysOverdue / 30)), D(0)).plus(r.oldBalance) });
  }
  parties.sort((a, b) => b.score.comparedTo(a.score) || b.outstanding.comparedTo(a.outstanding));
  const total = Object.values(buckets).reduce((s, v) => s.plus(v), D(0));
  const overdue = total.minus(buckets.notDue).minus(buckets.old);
  return { buckets, total, overdue, parties };
}
