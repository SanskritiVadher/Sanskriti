/**
 * Returns with GST notes.
 *  - Credit note: customer returns goods from an invoice. Reverses that share of sales + output GST,
 *    reduces their dues, and puts the goods back into stock at the cost they left at.
 *  - Debit note: we return goods from a supplier bill. Reduces what we owe, reverses the input GST,
 *    and takes the goods out of stock at the cost they came in at.
 * Lines are priced exactly like the original line (same rate, discount, GST), so returns can't drift.
 */
import { and, eq, sql, desc } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { D, toDb } from "@/lib/money";
import { calcInvoice } from "@/lib/gst/calc";
import { stateByCode } from "@/lib/gst/states";
import { UserFacingError } from "@/lib/errors";
import { postEntryTx, type LineInput } from "@/lib/accounting/engine";
import { audit } from "./audit";

type ReturnLine = { sourceLineId: string; qty: string };
const qtyOf = (v: string) => { const s = (v ?? "").replace(/,/g, "").trim(); if (!s) return D(0); if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new UserFacingError("Quantities must be numbers."); return D(s); };

async function returnedSoFar(q: DB, kind: "CREDIT_NOTE" | "DEBIT_NOTE", sourceLineIds: string[]) {
  if (!sourceLineIds.length) return new Map<string, string>();
  const r = await q.execute<{ id: string; q: string }>(sql`
    SELECT l.source_line_id AS id, sum(l.quantity) AS q FROM gst_note_lines l JOIN gst_notes n ON n.id = l.note_id
    WHERE n.kind = ${kind} AND l.source_line_id IN ${sql.raw(`(${sourceLineIds.map((i) => `'${i.replace(/[^0-9a-f-]/gi, "")}'`).join(",")})`)}
    GROUP BY l.source_line_id`);
  return new Map(r.rows.map((x) => [x.id, x.q]));
}

export async function createCreditNote(db: DB, p: { companyId: string; userId: string; invoiceId: string; date: string; reason: string; lines: ReturnLine[] }) {
  if (!p.reason?.trim()) throw new UserFacingError("Please give a reason for the return.", "reason");
  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await tx.execute(sql`SELECT id FROM sales_invoices WHERE id = ${p.invoiceId} AND company_id = ${p.companyId} FOR UPDATE`);
    const inv = await tx.query.salesInvoices.findFirst({ where: and(eq(schema.salesInvoices.id, p.invoiceId), eq(schema.salesInvoices.companyId, p.companyId)) });
    if (!inv) throw new UserFacingError("Invoice not found.");
    if (inv.status === "CANCELLED") throw new UserFacingError("This invoice is cancelled; nothing to return.");
    if (p.date < inv.invoiceDate) throw new UserFacingError("A return can't be dated before the invoice.");
    const src = await tx.query.salesInvoiceLines.findMany({ where: eq(schema.salesInvoiceLines.invoiceId, inv.id) });
    const done = await returnedSoFar(t, "CREDIT_NOTE", src.map((s) => s.id));
    const picked = p.lines.map((l) => ({ l, s: src.find((x) => x.id === l.sourceLineId), q: qtyOf(l.qty) })).filter((x) => x.q.gt(0));
    if (!picked.length) throw new UserFacingError("Enter how many of each item came back.");
    for (const x of picked) {
      if (!x.s) throw new UserFacingError("Item not on this invoice.");
      const left = D(x.s.quantity).minus(done.get(x.s.id) ?? 0);
      if (x.q.gt(left)) throw new UserFacingError(`"${x.s.description}": only ${left.toString()} can still be returned (${D(x.s.quantity).toString()} sold, ${D(done.get(x.s.id) ?? 0).toString()} already returned).`);
    }
    const calc = calcInvoice(picked.map((x) => ({ qty: x.q, rate: x.s!.rate, discountPct: x.s!.discountPct, gstRate: x.s!.gstRate })), inv.supplyType);
    const costs = picked.map((x) => D(toDb(x.q.mul(x.s!.unitCost))));
    const cost = costs.reduce((a, b) => a.plus(b), D(0));
    const utgst = inv.supplyType === "INTRA" && !!stateByCode(inv.placeOfSupply)?.utgst;
    const L: LineInput[] = [{ systemKey: "SALES_RETURNS", debit: calc.taxable.toFixed(2) }];
    if (calc.cgst.gt(0)) L.push({ systemKey: "OUTPUT_CGST", debit: calc.cgst.toFixed(2) });
    if (calc.sgst.gt(0)) L.push({ systemKey: utgst ? "OUTPUT_UTGST" : "OUTPUT_SGST", debit: calc.sgst.toFixed(2) });
    if (calc.igst.gt(0)) L.push({ systemKey: "OUTPUT_IGST", debit: calc.igst.toFixed(2) });
    if (calc.roundOff.gt(0)) L.push({ systemKey: "ROUND_OFF", debit: calc.roundOff.toFixed(2) });
    if (calc.roundOff.lt(0)) L.push({ systemKey: "ROUND_OFF", credit: calc.roundOff.abs().toFixed(2) });
    L.push({ systemKey: "DEBTORS_CONTROL", partyId: inv.partyId, credit: calc.total.toFixed(2) });
    if (cost.gt(0)) L.push({ systemKey: "INVENTORY", debit: cost.toFixed(2) }, { systemKey: "COGS", credit: cost.toFixed(2) });
    const entry = await postEntryTx(tx, { companyId: p.companyId, userId: p.userId, voucherType: "CREDIT_NOTE", date: p.date,
      narration: `Goods returned by ${inv.customerName} against ${inv.number}`, sourceType: "credit_note", lines: L });
    const [n] = await tx.insert(schema.gstNotes).values({ companyId: p.companyId, kind: "CREDIT_NOTE", partyId: inv.partyId, invoiceId: inv.id, entryId: entry.id,
      number: entry.voucherNumber, noteDate: p.date, reason: p.reason.trim(), supplyType: inv.supplyType, taxable: calc.taxable.toFixed(2),
      cgst: calc.cgst.toFixed(2), sgst: calc.sgst.toFixed(2), igst: calc.igst.toFixed(2), roundOff: calc.roundOff.toFixed(2), total: calc.total.toFixed(2),
      costValue: cost.toFixed(2), createdBy: p.userId }).returning();
    await tx.insert(schema.gstNoteLines).values(picked.map((x, i) => ({ noteId: n.id, lineNo: i + 1, productId: x.s!.productId, sourceLineId: x.s!.id,
      quantity: x.q.toFixed(3), rate: x.s!.rate, taxable: calc.lines[i].taxable.toFixed(2), gstRate: x.s!.gstRate, cgst: calc.lines[i].cgst.toFixed(2),
      sgst: calc.lines[i].sgst.toFixed(2), igst: calc.lines[i].igst.toFixed(2), unitCost: x.s!.unitCost, costValue: costs[i].toFixed(2) })));
    const wh = await tx.query.warehouses.findFirst({ where: and(eq(schema.warehouses.companyId, p.companyId), eq(schema.warehouses.isDefault, true)) });
    await tx.insert(schema.inventoryTransactions).values(picked.map((x, i) => ({ companyId: p.companyId, productId: x.s!.productId, warehouseId: wh!.id, txnDate: p.date,
      type: "SALES_RETURN" as const, quantity: x.q.toFixed(3), unitCost: x.s!.unitCost, value: costs[i].toFixed(2), entryId: entry.id,
      sourceType: "credit_note", sourceId: n.id, note: `${n.number} · return from ${inv.customerName}`, createdBy: p.userId })));
    await audit(tx, { companyId: p.companyId, userId: p.userId, action: "credit_note.create", entityType: "gst_note", entityId: n.id, after: { number: n.number, invoice: inv.number, total: n.total }, reason: p.reason });
    return n;
  });
}

export async function createDebitNote(db: DB, p: { companyId: string; userId: string; billId: string; date: string; reason: string; lines: ReturnLine[] }) {
  if (!p.reason?.trim()) throw new UserFacingError("Please give a reason for the return.", "reason");
  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    await tx.execute(sql`SELECT id FROM purchase_bills WHERE id = ${p.billId} AND company_id = ${p.companyId} FOR UPDATE`);
    const bill = await tx.query.purchaseBills.findFirst({ where: and(eq(schema.purchaseBills.id, p.billId), eq(schema.purchaseBills.companyId, p.companyId)) });
    if (!bill) throw new UserFacingError("Bill not found.");
    if (bill.status === "CANCELLED") throw new UserFacingError("This bill is cancelled; nothing to return.");
    if (p.date < bill.billDate) throw new UserFacingError("A return can't be dated before the bill.");
    const party = (await tx.query.parties.findFirst({ where: eq(schema.parties.id, bill.partyId) }))!;
    const src = await tx.query.purchaseBillLines.findMany({ where: eq(schema.purchaseBillLines.billId, bill.id) });
    const done = await returnedSoFar(t, "DEBIT_NOTE", src.map((s) => s.id));
    const picked = p.lines.map((l) => ({ l, s: src.find((x) => x.id === l.sourceLineId), q: qtyOf(l.qty) })).filter((x) => x.q.gt(0));
    if (!picked.length) throw new UserFacingError("Enter how many of each item you're sending back.");
    for (const x of picked) {
      if (!x.s) throw new UserFacingError("Item not on this bill.");
      const left = D(x.s.quantity).minus(done.get(x.s.id) ?? 0);
      if (x.q.gt(left)) throw new UserFacingError(`Only ${left.toString()} of this item can still be returned.`);
      await tx.execute(sql`SELECT id FROM products WHERE id = ${x.s.productId} FOR UPDATE`);
      const [st] = await tx.select({ q: sql<string>`coalesce(sum(${schema.inventoryTransactions.quantity}),0)`, v: sql<string>`coalesce(sum(${schema.inventoryTransactions.value}),0)` })
        .from(schema.inventoryTransactions).where(eq(schema.inventoryTransactions.productId, x.s.productId));
      if (x.q.gt(st.q)) throw new UserFacingError(`Only ${D(st.q).toString()} in stock; you can't send back ${x.q.toString()}.`);
      if (D(toDb(x.q.mul(x.s.unitCost))).gt(st.v)) throw new UserFacingError("Stock value is lower than this return's cost. Correct the stock first (Inventory → the product → Correct the stock).");
    }
    const calc = calcInvoice(picked.map((x) => ({ qty: x.q, rate: x.s!.rate, gstRate: x.s!.gstRate })), bill.supplyType);
    const costs = picked.map((x) => D(toDb(x.q.mul(x.s!.unitCost))));
    const cost = costs.reduce((a, b) => a.plus(b), D(0));
    const company = (await tx.query.companies.findFirst({ where: eq(schema.companies.id, p.companyId) }))!;
    const utgst = bill.supplyType === "INTRA" && !!stateByCode(company.stateCode)?.utgst;
    // What we owe goes down by the note total; stock by its cost; claimed input GST is reversed; the rest is round-off.
    const L: LineInput[] = [{ systemKey: "CREDITORS_CONTROL", partyId: bill.partyId, debit: calc.total.toFixed(2) }, { systemKey: "INVENTORY", credit: cost.toFixed(2) }];
    let credited = cost;
    if (bill.itcClaimed) {
      if (calc.cgst.gt(0)) L.push({ systemKey: "INPUT_CGST", credit: calc.cgst.toFixed(2) });
      if (calc.sgst.gt(0)) L.push({ systemKey: utgst ? "INPUT_UTGST" : "INPUT_SGST", credit: calc.sgst.toFixed(2) });
      if (calc.igst.gt(0)) L.push({ systemKey: "INPUT_IGST", credit: calc.igst.toFixed(2) });
      credited = credited.plus(calc.tax);
    }
    const diff = calc.total.minus(credited);
    if (diff.gt(0)) L.push({ systemKey: "ROUND_OFF", credit: diff.toFixed(2) });
    if (diff.lt(0)) L.push({ systemKey: "ROUND_OFF", debit: diff.abs().toFixed(2) });
    const entry = await postEntryTx(tx, { companyId: p.companyId, userId: p.userId, voucherType: "DEBIT_NOTE", date: p.date,
      narration: `Goods returned to ${party.name} against bill ${bill.billNumber}`, sourceType: "debit_note", lines: L.filter((l) => !D(l.debit ?? l.credit ?? 0).isZero()) });
    const [n] = await tx.insert(schema.gstNotes).values({ companyId: p.companyId, kind: "DEBIT_NOTE", partyId: bill.partyId, billId: bill.id, entryId: entry.id,
      number: entry.voucherNumber, noteDate: p.date, reason: p.reason.trim(), supplyType: bill.supplyType, taxable: calc.taxable.toFixed(2),
      cgst: calc.cgst.toFixed(2), sgst: calc.sgst.toFixed(2), igst: calc.igst.toFixed(2), roundOff: calc.roundOff.toFixed(2), total: calc.total.toFixed(2),
      costValue: cost.toFixed(2), createdBy: p.userId }).returning();
    await tx.insert(schema.gstNoteLines).values(picked.map((x, i) => ({ noteId: n.id, lineNo: i + 1, productId: x.s!.productId, sourceLineId: x.s!.id,
      quantity: x.q.toFixed(3), rate: x.s!.rate, taxable: calc.lines[i].taxable.toFixed(2), gstRate: x.s!.gstRate, cgst: calc.lines[i].cgst.toFixed(2),
      sgst: calc.lines[i].sgst.toFixed(2), igst: calc.lines[i].igst.toFixed(2), unitCost: x.s!.unitCost, costValue: costs[i].toFixed(2) })));
    const wh = await tx.query.warehouses.findFirst({ where: and(eq(schema.warehouses.companyId, p.companyId), eq(schema.warehouses.isDefault, true)) });
    await tx.insert(schema.inventoryTransactions).values(picked.map((x, i) => ({ companyId: p.companyId, productId: x.s!.productId, warehouseId: wh!.id, txnDate: p.date,
      type: "PURCHASE_RETURN" as const, quantity: x.q.neg().toFixed(3), unitCost: x.s!.unitCost, value: costs[i].neg().toFixed(2), entryId: entry.id,
      sourceType: "debit_note", sourceId: n.id, note: `${n.number} · returned to ${party.name}`, createdBy: p.userId })));
    await audit(tx, { companyId: p.companyId, userId: p.userId, action: "debit_note.create", entityType: "gst_note", entityId: n.id, after: { number: n.number, bill: bill.billNumber, total: n.total }, reason: p.reason });
    return n;
  });
}

export async function returnableLines(db: DB, kind: "CREDIT_NOTE" | "DEBIT_NOTE", docId: string) {
  const src = kind === "CREDIT_NOTE"
    ? (await db.query.salesInvoiceLines.findMany({ where: eq(schema.salesInvoiceLines.invoiceId, docId), orderBy: schema.salesInvoiceLines.lineNo }))
        .map((l) => ({ id: l.id, name: l.description, qty: D(l.quantity), rate: l.rate, unit: l.unit }))
    : (await db.select({ l: schema.purchaseBillLines, name: schema.products.name, unit: schema.products.unit }).from(schema.purchaseBillLines)
        .innerJoin(schema.products, eq(schema.products.id, schema.purchaseBillLines.productId)).where(eq(schema.purchaseBillLines.billId, docId)).orderBy(schema.purchaseBillLines.lineNo))
        .map(({ l, name, unit }) => ({ id: l.id, name, qty: D(l.quantity), rate: l.rate, unit }));
  const done = await returnedSoFar(db, kind, src.map((s) => s.id));
  return src.map((s) => ({ ...s, returned: D(done.get(s.id) ?? 0), left: s.qty.minus(done.get(s.id) ?? 0) }));
}

export async function notesFor(db: DB, companyId: string, where: { invoiceId?: string; billId?: string }) {
  return db.query.gstNotes.findMany({ where: and(eq(schema.gstNotes.companyId, companyId),
    where.invoiceId ? eq(schema.gstNotes.invoiceId, where.invoiceId) : eq(schema.gstNotes.billId, where.billId!)), orderBy: desc(schema.gstNotes.noteDate) });
}
