/**
 * Supplier bills. One bill = one balanced entry (stock, input GST, supplier dues, round-off) + stock movements.
 * If the business can't claim GST back (unregistered/composition), the GST paid becomes part of stock cost.
 */
import { and, eq, sql, desc, ne } from "drizzle-orm";

import { schema, type DB } from "@/db";
import { D, toDb, formatINR } from "@/lib/money";
import { calcInvoice } from "@/lib/gst/calc";
import { stateByCode } from "@/lib/gst/states";
import { UserFacingError } from "@/lib/errors";
import { postEntryTx, reverseEntryTx, type LineInput } from "@/lib/accounting/engine";
import { audit } from "./audit";
import { cashPaymentWarnings } from "./sales";

export type BillLineInput = { productId: string; qty: string; rate: string; gstRate?: string };
export type BillInput = { companyId: string; userId: string; partyId: string; billNumber: string; date: string; lines: BillLineInput[];
  paidNow?: { amount: string; cashBankId: string }; notes?: string };

const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const num = (v: string | undefined, label: string, max = 3) => {
  const s = (v ?? "").replace(/[,₹\s%]/g, "");
  if (!new RegExp(`^\\d+(\\.\\d{1,${max}})?$`).test(s)) throw new UserFacingError(`${label} is not a valid number.`);
  return D(s);
};

export async function createBill(db: DB, input: BillInput) {
  const warnings: string[] = [];
  const bill = await db.transaction(async (tx) => {
    const company = (await tx.query.companies.findFirst({ where: eq(schema.companies.id, input.companyId) }))!;
    const party = await tx.query.parties.findFirst({ where: and(eq(schema.parties.id, input.partyId), eq(schema.parties.companyId, input.companyId)) });
    if (!party || party.type !== "SUPPLIER") throw new UserFacingError("Please choose a supplier.", "partyId");
    const billNumber = input.billNumber?.trim();
    if (!billNumber) throw new UserFacingError("Enter the supplier's bill number (printed on their bill).", "billNumber");
    const dup = await tx.query.purchaseBills.findFirst({ where: and(eq(schema.purchaseBills.companyId, input.companyId), eq(schema.purchaseBills.partyId, party.id),
      sql`lower(${schema.purchaseBills.billNumber}) = lower(${billNumber})`, ne(schema.purchaseBills.status, "CANCELLED")) });
    if (dup) throw new UserFacingError(`Bill ${billNumber} from ${party.name} is already recorded (${dup.number}). Is this a duplicate?`, "billNumber");
    if (!input.lines?.length) throw new UserFacingError("Add at least one product.");

    // Supplier charges GST only if they're registered. Intra/inter from their state vs ours.
    const supplierState = party.stateCode ?? company.stateCode;
    if (!party.stateCode && party.gstin == null) warnings.push(`${party.name} has no state saved; assumed same state as you.`);
    const type = !party.gstin ? "NONE" : supplierState === company.stateCode ? "INTRA" : "INTER";
    const itc = company.gstRegistration === "REGULAR" && type !== "NONE";
    const utgst = type === "INTRA" && !!stateByCode(company.stateCode)?.utgst;

    const products = new Map((await tx.query.products.findMany({ where: eq(schema.products.companyId, input.companyId) })).map((p) => [p.id, p]));
    const parsed = input.lines.map((l, i) => {
      const p = products.get(l.productId);
      if (!p) throw new UserFacingError(`Line ${i + 1}: product not found.`);
      const qty = num(l.qty, `Line ${i + 1} quantity`);
      if (qty.lte(0)) throw new UserFacingError(`Line ${i + 1}: quantity must be more than zero.`);
      const rate = num(l.rate, `Line ${i + 1} rate`, 2);
      const gr = type === "NONE" ? D(0) : l.gstRate ? num(l.gstRate, `Line ${i + 1} GST rate`, 2) : p.gstRate != null ? D(p.gstRate) : null;
      if (gr == null) throw new UserFacingError(`Line ${i + 1}: enter the GST rate shown on the supplier's bill for "${p.name}".`);
      return { p, qty, rate, gr };
    });
    const calc = calcInvoice(parsed.map((l) => ({ qty: l.qty, rate: l.rate, gstRate: l.gr })), type);

    // Price-rise warnings vs the last bill from this supplier.
    for (const l of parsed) {
      const last = await tx.execute<{ rate: string; bill_date: string }>(sql`
        SELECT bl.rate, b.bill_date FROM purchase_bill_lines bl JOIN purchase_bills b ON b.id = bl.bill_id
        WHERE b.company_id = ${input.companyId} AND b.party_id = ${party.id} AND bl.product_id = ${l.p.id} AND b.status = 'ACTIVE'
        ORDER BY b.bill_date DESC, b.created_at DESC LIMIT 1`);
      const prev = last.rows[0];
      if (prev && l.rate.gt(prev.rate)) warnings.push(`${party.name} charged ${formatINR(l.rate)} for "${l.p.name}", up ${l.rate.minus(prev.rate).div(prev.rate).mul(100).toFixed(1)}% from ${formatINR(prev.rate)} last time.`);
    }

    // Stock cost per line = taxable (+ GST if it can't be claimed). Round-off goes to its own account.
    const costs = parsed.map((_, i) => itc ? calc.lines[i].taxable : calc.lines[i].taxable.plus(calc.lines[i].cgst).plus(calc.lines[i].sgst).plus(calc.lines[i].igst));
    const stockTotal = costs.reduce((s, c) => s.plus(c), D(0));
    const L: LineInput[] = [{ systemKey: "INVENTORY", debit: stockTotal.toFixed(2) }];
    if (itc && calc.cgst.gt(0)) L.push({ systemKey: "INPUT_CGST", debit: calc.cgst.toFixed(2) });
    if (itc && calc.sgst.gt(0)) L.push({ systemKey: utgst ? "INPUT_UTGST" : "INPUT_SGST", debit: calc.sgst.toFixed(2) });
    if (itc && calc.igst.gt(0)) L.push({ systemKey: "INPUT_IGST", debit: calc.igst.toFixed(2) });
    if (calc.roundOff.gt(0)) L.push({ systemKey: "ROUND_OFF", debit: calc.roundOff.toFixed(2) });
    if (calc.roundOff.lt(0)) L.push({ systemKey: "ROUND_OFF", credit: calc.roundOff.abs().toFixed(2) });
    L.push({ systemKey: "CREDITORS_CONTROL", partyId: party.id, credit: calc.total.toFixed(2) });
    const entry = await postEntryTx(tx, { companyId: input.companyId, userId: input.userId, voucherType: "PURCHASE", date: input.date,
      narration: `Purchase from ${party.name}, bill ${billNumber}`, sourceType: "purchase_bill", lines: L });

    const [b] = await tx.insert(schema.purchaseBills).values({ companyId: input.companyId, partyId: party.id, entryId: entry.id, number: entry.voucherNumber,
      billNumber, billDate: input.date, dueDate: addDays(input.date, party.creditDays ?? 0), supplyType: type,
      taxable: calc.taxable.toFixed(2), cgst: calc.cgst.toFixed(2), sgst: calc.sgst.toFixed(2), igst: calc.igst.toFixed(2),
      roundOff: calc.roundOff.toFixed(2), total: calc.total.toFixed(2), itcClaimed: itc, notes: input.notes?.trim() || null, createdBy: input.userId }).returning();
    await tx.insert(schema.purchaseBillLines).values(parsed.map((l, i) => ({ billId: b.id, lineNo: i + 1, productId: l.p.id,
      quantity: l.qty.toFixed(3), rate: l.rate.toFixed(2), taxable: calc.lines[i].taxable.toFixed(2), gstRate: calc.lines[i].gstRate.toFixed(2),
      cgst: calc.lines[i].cgst.toFixed(2), sgst: calc.lines[i].sgst.toFixed(2), igst: calc.lines[i].igst.toFixed(2), unitCost: costs[i].div(l.qty).toFixed(4) })));
    const wh = await tx.query.warehouses.findFirst({ where: and(eq(schema.warehouses.companyId, input.companyId), eq(schema.warehouses.isDefault, true)) });
    await tx.insert(schema.inventoryTransactions).values(parsed.map((l, i) => ({ companyId: input.companyId, productId: l.p.id, warehouseId: wh!.id,
      txnDate: input.date, type: "PURCHASE" as const, quantity: l.qty.toFixed(3), unitCost: costs[i].div(l.qty).toFixed(4), value: toDb(costs[i]),
      entryId: entry.id, sourceType: "purchase_bill", sourceId: b.id, note: `Bill ${billNumber} · ${party.name}`, createdBy: input.userId })));

    const paid = input.paidNow?.amount ? num(input.paidNow.amount, "Amount paid", 2) : D(0);
    if (paid.gt(calc.total)) throw new UserFacingError("Amount paid is more than the bill total.");
    if (paid.gt(0)) {
      const cb = await tx.query.accounts.findFirst({ where: and(eq(schema.accounts.id, input.paidNow!.cashBankId), eq(schema.accounts.companyId, input.companyId)) });
      const g = cb && await tx.query.accountGroups.findFirst({ where: eq(schema.accountGroups.id, cb.groupId) });
      if (!cb || !g || !["1110", "1120"].includes(g.code)) throw new UserFacingError("Choose where the money was paid from (cash or bank).");
      await postEntryTx(tx, { companyId: input.companyId, userId: input.userId, voucherType: "PAYMENT", date: input.date,
        narration: `Payment for bill ${billNumber}`, sourceType: "purchase_payment", sourceId: b.id,
        lines: [{ systemKey: "CREDITORS_CONTROL", partyId: party.id, debit: paid.toFixed(2) }, { accountId: cb.id, credit: paid.toFixed(2) }] });
      if (g.code === "1110") warnings.push(...await cashPaymentWarnings(tx, input.companyId, input.date, paid, party.id));
    }
    if (!itc && type !== "NONE") warnings.push("GST on this bill can't be claimed back (you're not a regular GST registrant), so it's added to the stock cost.");
    await audit(tx, { companyId: input.companyId, userId: input.userId, action: "purchase.create", entityType: "purchase_bill", entityId: b.id,
      after: { number: b.number, billNumber, party: party.name, total: b.total, warnings } });
    return b;
  });
  return { bill, warnings };
}

/** Cancel a bill: reverse the entry and take the stock back out at the value it came in. Refused if that stock is already sold. */
export async function cancelBill(db: DB, p: { companyId: string; userId: string; billId: string; reason: string }) {
  if (!p.reason?.trim()) throw new UserFacingError("Please give a reason for cancelling.", "reason");
  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT id FROM purchase_bills WHERE id = ${p.billId} AND company_id = ${p.companyId} FOR UPDATE`);
    if (!lock.rows.length) throw new UserFacingError("Bill not found.");
    const b = (await tx.query.purchaseBills.findFirst({ where: eq(schema.purchaseBills.id, p.billId) }))!;
    if (b.status === "CANCELLED") throw new UserFacingError("This bill is already cancelled.");
    const ret = await tx.query.gstNotes.findFirst({ where: eq(schema.gstNotes.billId, b.id) });
    if (ret) throw new UserFacingError(`Some goods from this bill were already returned (${ret.number}), so it can't be cancelled. Use "Return goods to supplier" for the rest.`);
    const moves = await tx.query.inventoryTransactions.findMany({ where: and(eq(schema.inventoryTransactions.sourceType, "purchase_bill"), eq(schema.inventoryTransactions.sourceId, b.id)) });
    for (const m of moves) {
      await tx.execute(sql`SELECT id FROM products WHERE id = ${m.productId} FOR UPDATE`);
      const [s] = await tx.select({ q: sql<string>`coalesce(sum(${schema.inventoryTransactions.quantity}),0)`, v: sql<string>`coalesce(sum(${schema.inventoryTransactions.value}),0)` })
        .from(schema.inventoryTransactions).where(eq(schema.inventoryTransactions.productId, m.productId));
      if (D(s.q).lt(m.quantity) || D(s.v).lt(m.value)) {
        const prod = await tx.query.products.findFirst({ where: eq(schema.products.id, m.productId) });
        throw new UserFacingError(`Some of "${prod?.name}" from this bill has already been sold, so the bill can't simply be cancelled. Record a purchase return instead (coming with GST credit notes).`);
      }
    }
    await reverseEntryTx(tx, { companyId: p.companyId, userId: p.userId, entryId: b.entryId, reason: `Bill ${b.billNumber} cancelled: ${p.reason.trim()}` });
    if (moves.length) await tx.insert(schema.inventoryTransactions).values(moves.map((m) => ({ companyId: m.companyId, productId: m.productId, warehouseId: m.warehouseId,
      txnDate: b.billDate, type: "PURCHASE_RETURN" as const, quantity: D(m.quantity).neg().toFixed(3), unitCost: m.unitCost, value: D(m.value).neg().toFixed(2),
      entryId: b.entryId, sourceType: "purchase_bill_cancel", sourceId: b.id, note: `Bill ${b.billNumber} cancelled`, createdBy: p.userId })));
    await tx.update(schema.purchaseBills).set({ status: "CANCELLED", cancelReason: p.reason.trim() }).where(eq(schema.purchaseBills.id, b.id));
    await audit(tx, { companyId: p.companyId, userId: p.userId, action: "purchase.cancel", entityType: "purchase_bill", entityId: b.id, reason: p.reason.trim() });
    return b;
  });
}

export async function listBills(db: DB, companyId: string) {
  return db.select({ b: schema.purchaseBills, supplier: schema.parties.name }).from(schema.purchaseBills)
    .innerJoin(schema.parties, eq(schema.parties.id, schema.purchaseBills.partyId))
    .where(eq(schema.purchaseBills.companyId, companyId)).orderBy(desc(schema.purchaseBills.billDate), desc(schema.purchaseBills.createdAt)).limit(300);
}

export async function getBill(db: DB, companyId: string, id: string) {
  const b = await db.query.purchaseBills.findFirst({ where: and(eq(schema.purchaseBills.id, id), eq(schema.purchaseBills.companyId, companyId)) });
  if (!b) return null;
  const lines = await db.select({ l: schema.purchaseBillLines, name: schema.products.name, unit: schema.products.unit })
    .from(schema.purchaseBillLines).innerJoin(schema.products, eq(schema.products.id, schema.purchaseBillLines.productId))
    .where(eq(schema.purchaseBillLines.billId, id)).orderBy(schema.purchaseBillLines.lineNo);
  const party = await db.query.parties.findFirst({ where: eq(schema.parties.id, b.partyId) });
  return { b, lines, party: party! };
}
