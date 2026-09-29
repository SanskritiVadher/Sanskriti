/**
 * Customers and suppliers. Their dues are NEVER stored on the party row — they are always the sum of
 * that party's lines on the debtors/creditors control accounts, so they can't drift from the ledger.
 */
import { and, eq, sql, ilike, or, desc, asc } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { D, toDb } from "@/lib/money";
import { validateGstin } from "@/lib/gst/gstin";
import { stateByCode } from "@/lib/gst/states";
import { UserFacingError } from "@/lib/errors";
import { postEntryTx, LedgerError } from "@/lib/accounting/engine";
import { reverseInTx } from "./vouchers";
import { audit } from "./audit";
import { todayIST } from "@/lib/dates";

export type PartyType = "CUSTOMER" | "SUPPLIER";
export type PartyInput = {
  name: string; contactPerson?: string; phone?: string; whatsapp?: string; email?: string; gstin?: string;
  stateCode?: string; addressLine1?: string; city?: string; pincode?: string;
  creditLimit?: string; creditDays?: string; priceLevel?: "DEALER" | "WHOLESALE" | "RETAIL"; notes?: string;
};

const clean = (v?: string) => (v ?? "").trim() || null;
/** Indian mobile → 10 digits, or null. Accepts +91, 0-prefix, spaces, dashes. */
export function normalisePhone(v?: string | null) {
  const d = (v ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!d) return null;
  if (!/^[6-9]\d{9}$/.test(d)) return "INVALID";
  return d;
}

export function validatePartyInput(input: PartyInput) {
  const name = input.name?.trim();
  if (!name) throw new UserFacingError("Please enter a name.", "name");
  let gstin: string | null = null, stateCode = clean(input.stateCode);
  if (clean(input.gstin)) {
    const r = validateGstin(input.gstin!);
    if (!r.ok) throw new UserFacingError(`GSTIN: ${r.message}`, "gstin");
    gstin = r.gstin;
    if (stateCode && stateCode !== r.stateCode)
      throw new UserFacingError(`This GSTIN is from ${r.stateName}, but the state chosen is ${stateByCode(stateCode)?.name}.`, "gstin");
    stateCode = r.stateCode;
  }
  if (stateCode && !stateByCode(stateCode)) throw new UserFacingError("Please choose a valid state.", "stateCode");
  const phone = normalisePhone(input.phone), whatsapp = normalisePhone(input.whatsapp || input.phone);
  if (phone === "INVALID") throw new UserFacingError("Phone should be a 10-digit Indian mobile number.", "phone");
  if (whatsapp === "INVALID") throw new UserFacingError("WhatsApp should be a 10-digit Indian mobile number.", "whatsapp");
  const lim = clean(input.creditLimit)?.replace(/[,₹\s]/g, "");
  if (lim && (!/^\d+(\.\d{1,2})?$/.test(lim))) throw new UserFacingError("Credit limit should be an amount like 200000.", "creditLimit");
  const days = clean(input.creditDays);
  if (days && (!/^\d{1,3}$/.test(days))) throw new UserFacingError("Credit days should be a whole number like 30.", "creditDays");
  const pin = clean(input.pincode);
  if (pin && !/^[1-9]\d{5}$/.test(pin)) throw new UserFacingError("PIN code should be 6 digits.", "pincode");
  return {
    name, contactPerson: clean(input.contactPerson), phone, whatsapp, email: clean(input.email)?.toLowerCase() ?? null, gstin, stateCode,
    addressLine1: clean(input.addressLine1), city: clean(input.city), pincode: pin,
    creditLimit: lim ? toDb(lim) : null, creditDays: days ? Number(days) : null, priceLevel: input.priceLevel ?? "DEALER", notes: clean(input.notes),
  };
}

async function assertNoDuplicate(db: DB, companyId: string, type: PartyType, v: { name: string; gstin: string | null }, exceptId?: string) {
  const dupName = await db.query.parties.findFirst({ where: and(eq(schema.parties.companyId, companyId), eq(schema.parties.type, type),
    sql`lower(${schema.parties.name}) = lower(${v.name})`) });
  if (dupName && dupName.id !== exceptId) throw new UserFacingError(`"${dupName.name}" already exists.`, "name");
  if (v.gstin) {
    const dupG = await db.query.parties.findFirst({ where: and(eq(schema.parties.companyId, companyId), eq(schema.parties.type, type), eq(schema.parties.gstin, v.gstin)) });
    if (dupG && dupG.id !== exceptId) throw new UserFacingError(`This GSTIN is already used by "${dupG.name}".`, "gstin");
  }
}

const CONTROL = { CUSTOMER: "DEBTORS_CONTROL", SUPPLIER: "CREDITORS_CONTROL" } as const;

/**
 * Create a party, optionally with an opening balance (amount they owed / we owed on `openingDate`).
 * The opening is posted through the engine: Dr Debtors (customer) or Cr Creditors (supplier) against
 * Opening Balance Equity.
 */
export async function createParty(db: DB, companyId: string, userId: string, type: PartyType, input: PartyInput & { openingBalance?: string; openingDate?: string }) {
  const v = validatePartyInput(input);
  await assertNoDuplicate(db, companyId, type, v);
  return db.transaction(async (tx) => {
    const [p] = await tx.insert(schema.parties).values({ companyId, type, ...v }).returning();
    await audit(tx, { companyId, userId, action: `${type.toLowerCase()}.create`, entityType: "party", entityId: p.id, after: p });
    if (clean(input.openingBalance)) await postPartyOpening(tx as unknown as DB, companyId, userId, p, input.openingBalance!, input.openingDate || todayIST());
    return p;
  });
}

export async function updateParty(db: DB, companyId: string, userId: string, id: string, input: PartyInput) {
  const before = await db.query.parties.findFirst({ where: and(eq(schema.parties.id, id), eq(schema.parties.companyId, companyId)) });
  if (!before) throw new UserFacingError("Not found.");
  const v = validatePartyInput(input);
  await assertNoDuplicate(db, companyId, before.type, v, id);
  const [after] = await db.update(schema.parties).set({ ...v, updatedAt: new Date() }).where(eq(schema.parties.id, id)).returning();
  await audit(db, { companyId, userId, action: "party.update", entityType: "party", entityId: id, before, after });
  return after;
}

async function postPartyOpening(tx: DB, companyId: string, userId: string, p: { id: string; type: PartyType; name: string }, raw: string, date: string) {
  const s = raw.replace(/[,₹\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new LedgerError("Opening balance should be an amount like 45000.", "openingBalance");
  const amt = D(s);
  if (amt.isZero()) return null;
  // Positive = normal direction (customer owes us / we owe supplier). Negative = advance the other way.
  const partyDebit = p.type === "CUSTOMER" ? amt.gt(0) : amt.lt(0);
  const a = toDb(amt.abs());
  return postEntryTx(tx as never, {
    companyId, userId, voucherType: "OPENING", date, sourceType: "opening_party", sourceId: p.id,
    narration: `Opening balance: ${p.name}`,
    lines: [
      { systemKey: CONTROL[p.type], partyId: p.id, ...(partyDebit ? { debit: a } : { credit: a }) },
      { systemKey: "OPENING_BALANCE_EQUITY", ...(partyDebit ? { credit: a } : { debit: a }) },
    ],
  });
}

/** Replace a party's opening balance (old one is reversed, not deleted). */
export async function setPartyOpening(db: DB, companyId: string, userId: string, partyId: string, raw: string, date: string) {
  return db.transaction(async (tx) => {
    const p = await tx.query.parties.findFirst({ where: and(eq(schema.parties.id, partyId), eq(schema.parties.companyId, companyId)) });
    if (!p) throw new UserFacingError("Not found.");
    const prev = await tx.query.journalEntries.findFirst({ where: and(eq(schema.journalEntries.companyId, companyId),
      eq(schema.journalEntries.sourceType, "opening_party"), eq(schema.journalEntries.sourceId, partyId), eq(schema.journalEntries.status, "POSTED")) });
    if (prev) await reverseInTx(tx, { companyId, userId }, prev.id);
    return postPartyOpening(tx as unknown as DB, companyId, userId, p, raw || "0", date);
  });
}

/** Balance per party, from the ledger. Customer: positive = they owe us. Supplier: positive = we owe them. */
export async function partyBalances(db: DB, companyId: string, type: PartyType, asOf = "9999-12-31") {
  const rows = await db.execute<{ party_id: string; dr: string; cr: string; last_payment: string | null; last_activity: string | null }>(sql`
    SELECT l.party_id, coalesce(sum(l.debit),0) AS dr, coalesce(sum(l.credit),0) AS cr,
      max(CASE WHEN e.voucher_type IN ('RECEIPT','PAYMENT') AND e.status = 'POSTED' THEN e.entry_date END) AS last_payment,
      max(e.entry_date) AS last_activity
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN parties p ON p.id = l.party_id
    WHERE l.company_id = ${companyId} AND p.type = ${type} AND e.entry_date <= ${asOf}
    GROUP BY l.party_id`);
  return new Map(rows.rows.map((r) => [r.party_id, {
    balance: type === "CUSTOMER" ? D(r.dr).minus(r.cr) : D(r.cr).minus(r.dr),
    lastPayment: r.last_payment, lastActivity: r.last_activity,
  }]));
}

export async function listParties(db: DB, companyId: string, type: PartyType, q?: string) {
  const where = and(eq(schema.parties.companyId, companyId), eq(schema.parties.type, type),
    q ? or(ilike(schema.parties.name, `%${q}%`), ilike(schema.parties.phone, `%${q}%`), ilike(schema.parties.city, `%${q}%`), ilike(schema.parties.gstin, `%${q}%`)) : undefined);
  const [list, bal] = await Promise.all([
    db.query.parties.findMany({ where, orderBy: [desc(schema.parties.isActive), asc(schema.parties.name)], limit: 500 }),
    partyBalances(db, companyId, type),
  ]);
  return list.map((p) => ({ ...p, ...(bal.get(p.id) ?? { balance: D(0), lastPayment: null, lastActivity: null }) }));
}

/** Statement of one party: every ledger line tagged to them, with running balance. */
export async function partyStatement(db: DB, companyId: string, partyId: string) {
  const p = await db.query.parties.findFirst({ where: and(eq(schema.parties.id, partyId), eq(schema.parties.companyId, companyId)) });
  if (!p) return null;
  const rows = await db.select({
    lineId: schema.journalLines.id, entryId: schema.journalEntries.id, date: schema.journalEntries.entryDate,
    voucherNumber: schema.journalEntries.voucherNumber, voucherType: schema.journalEntries.voucherType, status: schema.journalEntries.status,
    narration: schema.journalEntries.narration, debit: schema.journalLines.debit, credit: schema.journalLines.credit,
  }).from(schema.journalLines).innerJoin(schema.journalEntries, eq(schema.journalEntries.id, schema.journalLines.entryId))
    .where(and(eq(schema.journalLines.companyId, companyId), eq(schema.journalLines.partyId, partyId)))
    .orderBy(asc(schema.journalEntries.entryDate), asc(schema.journalEntries.createdAt));
  let bal = D(0);
  const lines = rows.map((r) => {
    bal = bal.plus(p.type === "CUSTOMER" ? D(r.debit).minus(r.credit) : D(r.credit).minus(r.debit));
    return { ...r, debit: D(r.debit), credit: D(r.credit), balance: bal };
  });
  return { party: p, lines, balance: bal };
}

/** Customer paid us: Dr Cash/Bank, Cr Debtors (tagged to the customer). */
export async function recordCustomerPayment(db: DB, p: { companyId: string; userId: string; partyId: string; cashBankId: string; amount: string; date: string; narration?: string }) {
  const party = await db.query.parties.findFirst({ where: and(eq(schema.parties.id, p.partyId), eq(schema.parties.companyId, p.companyId), eq(schema.parties.type, "CUSTOMER")) });
  if (!party) throw new UserFacingError("Customer not found.");
  const amt = amountOrThrow(p.amount);
  return db.transaction((tx) => postEntryTx(tx, { companyId: p.companyId, userId: p.userId, voucherType: "RECEIPT", date: p.date,
    narration: p.narration?.trim() || `Payment received from ${party.name}`,
    lines: [{ accountId: p.cashBankId, debit: amt }, { systemKey: "DEBTORS_CONTROL", partyId: party.id, credit: amt }] }));
}

/** We paid a supplier: Dr Creditors (tagged), Cr Cash/Bank. */
export async function recordSupplierPayment(db: DB, p: { companyId: string; userId: string; partyId: string; cashBankId: string; amount: string; date: string; narration?: string }) {
  const party = await db.query.parties.findFirst({ where: and(eq(schema.parties.id, p.partyId), eq(schema.parties.companyId, p.companyId), eq(schema.parties.type, "SUPPLIER")) });
  if (!party) throw new UserFacingError("Supplier not found.");
  const amt = amountOrThrow(p.amount);
  return db.transaction((tx) => postEntryTx(tx, { companyId: p.companyId, userId: p.userId, voucherType: "PAYMENT", date: p.date,
    narration: p.narration?.trim() || `Payment made to ${party.name}`,
    lines: [{ systemKey: "CREDITORS_CONTROL", partyId: party.id, debit: amt }, { accountId: p.cashBankId, credit: amt }] }));
}

function amountOrThrow(v: string) {
  const s = (v ?? "").replace(/[,₹\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s) || D(s).lte(0)) throw new LedgerError("Please enter an amount greater than zero (up to 2 decimals).", "amount");
  return s;
}

/** Pre-written, polite WhatsApp reminder. Opens WhatsApp with the text filled in; the owner presses send. */
export function whatsappReminderLink(p: { whatsapp: string | null; name: string }, businessName: string, amount: string) {
  if (!p.whatsapp) return null;
  const text = `Namaste ${p.name} ji,\n\nThis is a reminder from ${businessName}. Your outstanding balance with us is ${amount}.\n\nPlease arrange the payment at the earliest. If you have already paid, kindly ignore this message.\n\nThank you.`;
  return `https://wa.me/91${p.whatsapp}?text=${encodeURIComponent(text)}`;
}
