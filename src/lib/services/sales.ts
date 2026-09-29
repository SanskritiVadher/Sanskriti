/**
 * Sales invoices. One invoice = one balanced ledger entry (sales, GST, customer dues, round-off,
 * cost of goods sold, stock) + stock movements + the invoice document, all in ONE transaction.
 */
import { randomBytes } from "node:crypto";
import { and, eq, sql, desc, gte, lte } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB, type Tx } from "@/db";
import { D, toDb, formatINR } from "@/lib/money";
import { calcInvoice, supplyType } from "@/lib/gst/calc";
import { stateByCode } from "@/lib/gst/states";
import { UserFacingError } from "@/lib/errors";
import { postEntryTx, reverseEntryTx, type LineInput } from "@/lib/accounting/engine";
import { audit } from "./audit";
import { partyBalances } from "./parties";
import { receivablesFor } from "./receivables";

export type SaleLineInput = { productId: string; qty: string; rate: string; discountPct?: string; serials?: string };
export type SaleInput = {
  companyId: string; userId: string; partyId: string; date: string; lines: SaleLineInput[];
  paidNow?: { amount: string; cashBankId: string }; notes?: string; creditOverrideReason?: string; placeOfSupply?: string;
};
export class CreditLimitError extends UserFacingError {
  constructor(message: string, public details: { limit: string; current: string; projected: string; overdue: string }) { super(message, "credit"); }
}

const addDays = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const num = (v: string | undefined, label: string, max = 3) => {
  const s = (v ?? "").replace(/[,₹\s]/g, "");
  if (!new RegExp(`^\\d+(\\.\\d{1,${max}})?$`).test(s)) throw new UserFacingError(`${label} is not a valid number.`);
  return D(s);
};

export async function createSale(db: DB, input: SaleInput) {
  const warnings: string[] = [];
  const result = await db.transaction(async (tx) => {
    const company = await tx.query.companies.findFirst({ where: eq(schema.companies.id, input.companyId) });
    const party = await tx.query.parties.findFirst({ where: and(eq(schema.parties.id, input.partyId), eq(schema.parties.companyId, input.companyId)) });
    if (!company) throw new Error("company");
    if (!party || party.type !== "CUSTOMER") throw new UserFacingError("Please choose a customer.", "partyId");
    if (!party.isActive) throw new UserFacingError(`${party.name} is marked inactive.`, "partyId");
    if (!input.lines?.length) throw new UserFacingError("Add at least one product.");
    const pos = input.placeOfSupply || party.stateCode || company.stateCode;
    const type = supplyType(company.gstRegistration, company.stateCode, pos);
    const utgst = type === "INTRA" && !!stateByCode(company.stateCode)?.utgst;

    // Lock products (serialises concurrent sales of the same item) and validate each line.
    const ids = [...new Set(input.lines.map((l) => l.productId))];
    for (const id of [...ids].sort()) {
      const r = await tx.execute(sql`SELECT id FROM products WHERE id = ${id} AND company_id = ${input.companyId} FOR UPDATE`);
      if (!r.rows.length) throw new UserFacingError("One of the products wasn't found.");
    }
    const products = new Map((await tx.query.products.findMany({ where: eq(schema.products.companyId, input.companyId) })).filter((p) => ids.includes(p.id)).map((p) => [p.id, p]));
    const stock = new Map<string, { qty: Decimal; value: Decimal }>();
    for (const id of ids) {
      const [r] = await tx.select({ q: sql<string>`coalesce(sum(${schema.inventoryTransactions.quantity}),0)`, v: sql<string>`coalesce(sum(${schema.inventoryTransactions.value}),0)` })
        .from(schema.inventoryTransactions).where(eq(schema.inventoryTransactions.productId, id));
      stock.set(id, { qty: D(r.q), value: D(r.v) });
    }

    const parsed = input.lines.map((l, i) => {
      const p = products.get(l.productId)!;
      if (!p.isActive) throw new UserFacingError(`Line ${i + 1}: "${p.name}" is marked as not sold any more.`);
      const qty = num(l.qty, `Line ${i + 1} quantity`);
      if (qty.lte(0)) throw new UserFacingError(`Line ${i + 1}: quantity must be more than zero.`);
      const rate = num(l.rate, `Line ${i + 1} rate`, 2);
      const disc = num(l.discountPct || "0", `Line ${i + 1} discount`, 2);
      if (disc.gt(100)) throw new UserFacingError(`Line ${i + 1}: discount can't be more than 100%.`);
      if (type !== "NONE" && p.gstRate == null) throw new UserFacingError(`"${p.name}" has no GST rate. Set it on the product page first — the app won't guess tax rates.`);
      if (type !== "NONE" && p.gstRateStatus !== "USER_CONFIRMED") warnings.push(`GST rate for "${p.name}" (${D(p.gstRate!).toString()}%) is not confirmed yet.`);
      return { p, qty, rate, disc, serials: l.serials?.trim() || null };
    });

    // Stock check across lines (same product can appear twice).
    const need = new Map<string, Decimal>();
    for (const l of parsed) need.set(l.p.id, (need.get(l.p.id) ?? D(0)).plus(l.qty));
    for (const [id, q] of need) {
      const have = stock.get(id)!.qty;
      if (q.gt(have)) throw new UserFacingError(`Only ${have.toString()} ${products.get(id)!.unit} of "${products.get(id)!.name}" in stock; this bill needs ${q.toString()}. Record the purchase first.`);
    }

    const calc = calcInvoice(parsed.map((l) => ({ qty: l.qty, rate: l.rate, discountPct: l.disc, gstRate: l.p.gstRate })), type);
    if (calc.total.lte(0)) throw new UserFacingError("The bill total must be more than zero.");

    // Cost of goods at weighted-average cost; last units of a product take exactly the remaining value.
    const remaining = new Map([...stock].map(([k, v]) => [k, { ...v }]));
    const costs = parsed.map((l) => {
      const r = remaining.get(l.p.id)!;
      const avg = r.qty.gt(0) ? r.value.div(r.qty) : D(0);
      const value = l.qty.eq(r.qty) ? r.value : D(toDb(l.qty.mul(avg)));
      r.qty = r.qty.minus(l.qty); r.value = r.value.minus(value);
      return { unitCost: avg, value };
    });
    const cogs = costs.reduce((s, c) => s.plus(c.value), D(0));

    // Margin warnings (never blocking).
    parsed.forEach((l, i) => {
      const net = calc.lines[i].taxable.div(l.qty);
      if (l.p.minSellingPrice && net.lt(l.p.minSellingPrice)) warnings.push(`"${l.p.name}" sold at ${formatINR(net)} each, below your lowest allowed price of ${formatINR(l.p.minSellingPrice)}.`);
      else if (costs[i].unitCost.gt(0) && net.lt(costs[i].unitCost)) warnings.push(`"${l.p.name}" sold at ${formatINR(net)} each, below its cost of ${formatINR(costs[i].unitCost)} — this line loses money.`);
    });

    // Credit control.
    const paid = input.paidNow?.amount ? num(input.paidNow.amount, "Amount paid now", 2) : D(0);
    if (paid.gt(calc.total)) throw new UserFacingError("Amount paid now is more than the bill total.");
    const current = (await partyBalances(tx as unknown as DB, input.companyId, "CUSTOMER")).get(party.id)?.balance ?? D(0);
    const projected = current.plus(calc.total).minus(paid);
    const rec = await receivablesFor(tx as unknown as DB, input.companyId, party.id, input.date);
    if (party.creditLimit && projected.gt(party.creditLimit) && calc.total.gt(paid)) {
      if (!input.creditOverrideReason?.trim())
        throw new CreditLimitError(`This bill would take ${party.name} to ${formatINR(projected)}, over their credit limit of ${formatINR(party.creditLimit)} by ${formatINR(projected.minus(party.creditLimit))}.`,
          { limit: party.creditLimit, current: current.toFixed(2), projected: projected.toFixed(2), overdue: rec.overdue.toFixed(2) });
      warnings.push(`Credit limit crossed by ${formatINR(projected.minus(party.creditLimit))}. Reason recorded: ${input.creditOverrideReason.trim()}`);
    }
    if (rec.overdue.gt(0) && calc.total.gt(paid)) warnings.push(`${party.name} already has ${formatINR(rec.overdue)} overdue (oldest ${rec.oldestOverdueDays} days).`);
    if (type === "INTER" && calc.total.gt(50000)) warnings.push("Inter-state bill over ₹50,000: an e-way bill is needed before the goods move (generate it on the e-way bill portal).");

    // One entry for the whole sale.
    const sgstKey = utgst ? "OUTPUT_UTGST" : "OUTPUT_SGST";
    const L: LineInput[] = [{ systemKey: "DEBTORS_CONTROL", partyId: party.id, debit: calc.total.toFixed(2) }];
    L.push({ systemKey: "SALES", credit: calc.taxable.toFixed(2) });
    if (calc.cgst.gt(0)) L.push({ systemKey: "OUTPUT_CGST", credit: calc.cgst.toFixed(2) });
    if (calc.sgst.gt(0)) L.push({ systemKey: sgstKey, credit: calc.sgst.toFixed(2) });
    if (calc.igst.gt(0)) L.push({ systemKey: "OUTPUT_IGST", credit: calc.igst.toFixed(2) });
    if (calc.roundOff.gt(0)) L.push({ systemKey: "ROUND_OFF", credit: calc.roundOff.toFixed(2) });
    if (calc.roundOff.lt(0)) L.push({ systemKey: "ROUND_OFF", debit: calc.roundOff.abs().toFixed(2) });
    if (cogs.gt(0)) L.push({ systemKey: "COGS", debit: cogs.toFixed(2) }, { systemKey: "INVENTORY", credit: cogs.toFixed(2) });
    const entry = await postEntryTx(tx, { companyId: input.companyId, userId: input.userId, voucherType: "SALES", date: input.date,
      narration: `Sale to ${party.name}`, sourceType: "sales_invoice", lines: L });

    const dueDate = addDays(input.date, party.creditDays ?? 0);
    const [inv] = await tx.insert(schema.salesInvoices).values({
      companyId: input.companyId, partyId: party.id, entryId: entry.id, number: entry.voucherNumber, invoiceDate: input.date, dueDate,
      docType: type === "NONE" ? "BILL_OF_SUPPLY" : "TAX_INVOICE", supplyType: type, placeOfSupply: pos,
      customerName: party.name, customerGstin: party.gstin, customerPhone: party.phone,
      customerAddress: [party.addressLine1, party.city, party.pincode, stateByCode(party.stateCode)?.name].filter(Boolean).join(", ") || null,
      subtotal: calc.subtotal.toFixed(2), discount: calc.discount.toFixed(2), taxable: calc.taxable.toFixed(2),
      cgst: calc.cgst.toFixed(2), sgst: calc.sgst.toFixed(2), igst: calc.igst.toFixed(2), roundOff: calc.roundOff.toFixed(2),
      total: calc.total.toFixed(2), costOfGoods: cogs.toFixed(2), paidAtSale: paid.toFixed(2),
      creditOverrideReason: input.creditOverrideReason?.trim() || null, notes: input.notes?.trim() || null,
      shareToken: randomBytes(18).toString("base64url"), createdBy: input.userId,
    }).returning();
    await tx.insert(schema.salesInvoiceLines).values(parsed.map((l, i) => ({
      invoiceId: inv.id, lineNo: i + 1, productId: l.p.id, description: l.p.name, hsn: l.p.hsn, unit: l.p.unit,
      quantity: l.qty.toFixed(3), rate: l.rate.toFixed(2), discountPct: l.disc.toFixed(2), taxable: calc.lines[i].taxable.toFixed(2),
      gstRate: calc.lines[i].gstRate.toFixed(2), cgst: calc.lines[i].cgst.toFixed(2), sgst: calc.lines[i].sgst.toFixed(2), igst: calc.lines[i].igst.toFixed(2),
      lineTotal: calc.lines[i].total.toFixed(2), unitCost: costs[i].unitCost.toFixed(4), costValue: costs[i].value.toFixed(2), serials: l.serials,
    })));
    const wh = await tx.query.warehouses.findFirst({ where: and(eq(schema.warehouses.companyId, input.companyId), eq(schema.warehouses.isDefault, true)) });
    await tx.insert(schema.inventoryTransactions).values(parsed.map((l, i) => ({
      companyId: input.companyId, productId: l.p.id, warehouseId: wh!.id, txnDate: input.date, type: "SALE" as const,
      quantity: l.qty.neg().toFixed(3), unitCost: costs[i].unitCost.toFixed(4), value: costs[i].value.neg().toFixed(2),
      entryId: entry.id, sourceType: "sales_invoice", sourceId: inv.id, note: `${inv.number} · ${party.name}`, createdBy: input.userId,
    })));

    if (paid.gt(0)) {
      const cb = await tx.query.accounts.findFirst({ where: and(eq(schema.accounts.id, input.paidNow!.cashBankId), eq(schema.accounts.companyId, input.companyId)) });
      const g = cb && await tx.query.accountGroups.findFirst({ where: eq(schema.accountGroups.id, cb.groupId) });
      if (!cb || !g || !["1110", "1120"].includes(g.code)) throw new UserFacingError("Choose where the money was received (cash or bank).");
      const pay = await postEntryTx(tx, { companyId: input.companyId, userId: input.userId, voucherType: "RECEIPT", date: input.date,
        narration: `Payment with ${inv.number}`, sourceType: "sales_payment", sourceId: inv.id,
        lines: [{ accountId: cb.id, debit: paid.toFixed(2) }, { systemKey: "DEBTORS_CONTROL", partyId: party.id, credit: paid.toFixed(2) }] });
      await tx.update(schema.salesInvoices).set({ paymentEntryId: pay.id }).where(eq(schema.salesInvoices.id, inv.id));
      if (g.code === "1110") warnings.push(...await cashReceiptWarnings(tx, input.companyId, party.id, input.date));
    }
    await audit(tx, { companyId: input.companyId, userId: input.userId, action: "sale.create", entityType: "sales_invoice", entityId: inv.id,
      after: { number: inv.number, party: party.name, total: inv.total, warnings }, reason: input.creditOverrideReason });
    return inv;
  });
  return { invoice: result, warnings };
}

/** Section 269ST (now renumbered in the Income-tax Act 2025): cash of ₹2 lakh or more from one person in a day is not allowed. */
export async function cashReceiptWarnings(q: Tx | DB, companyId: string, partyId: string, date: string) {
  const r = await q.execute<{ total: string }>(sql`
    SELECT coalesce(sum(l2.debit),0) AS total FROM journal_lines l
    JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'POSTED' AND e.voucher_type = 'RECEIPT' AND e.entry_date = ${date}
    JOIN journal_lines l2 ON l2.entry_id = e.id JOIN accounts a ON a.id = l2.account_id AND a.system_key = 'CASH'
    WHERE l.company_id = ${companyId} AND l.party_id = ${partyId} AND l.credit > 0`);
  const t = D(r.rows[0].total);
  return t.gte(200000) ? [`Cash received from this customer today totals ${formatINR(t)}. Receiving ₹2 lakh or more in cash from one person in a day can attract a penalty equal to the amount. Please check with your CA.`] : [];
}

/** Section 40A(3) (renumbered): a cash payment of more than ₹10,000 to one person in a day may not be allowed as an expense. */
export async function cashPaymentWarnings(q: Tx | DB, companyId: string, date: string, amount: Decimal.Value, partyId?: string) {
  let t = D(amount);
  if (partyId) {
    const r = await q.execute<{ total: string }>(sql`
      SELECT coalesce(sum(l2.credit),0) AS total FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id AND e.status = 'POSTED' AND e.voucher_type = 'PAYMENT' AND e.entry_date = ${date}
      JOIN journal_lines l2 ON l2.entry_id = e.id JOIN accounts a ON a.id = l2.account_id AND a.system_key = 'CASH'
      WHERE l.company_id = ${companyId} AND l.party_id = ${partyId} AND l.debit > 0`);
    t = D(r.rows[0].total);
  }
  return t.gt(10000) ? [`Cash paid ${partyId ? "to this supplier today totals" : "is"} ${formatINR(t)}. Cash payments over ₹10,000 to one person in a day may not be allowed as a business expense for income tax. Prefer bank/UPI, and check with your CA.`] : [];
}

/** Cancel an invoice: reverses the ledger entry and puts the goods back at their original cost. The number stays used. */
export async function cancelSale(db: DB, p: { companyId: string; userId: string; invoiceId: string; reason: string }) {
  if (!p.reason?.trim()) throw new UserFacingError("Please give a reason for cancelling.", "reason");
  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT id FROM sales_invoices WHERE id = ${p.invoiceId} AND company_id = ${p.companyId} FOR UPDATE`);
    if (!lock.rows.length) throw new UserFacingError("Invoice not found.");
    const inv = (await tx.query.salesInvoices.findFirst({ where: eq(schema.salesInvoices.id, p.invoiceId) }))!;
    if (inv.status === "CANCELLED") throw new UserFacingError("This invoice is already cancelled.");
    await reverseEntryTx(tx, { companyId: p.companyId, userId: p.userId, entryId: inv.entryId, reason: `Invoice ${inv.number} cancelled: ${p.reason.trim()}` });
    const moves = await tx.query.inventoryTransactions.findMany({ where: and(eq(schema.inventoryTransactions.sourceType, "sales_invoice"), eq(schema.inventoryTransactions.sourceId, inv.id)) });
    if (moves.length) await tx.insert(schema.inventoryTransactions).values(moves.map((m) => ({
      companyId: m.companyId, productId: m.productId, warehouseId: m.warehouseId, txnDate: inv.invoiceDate, type: "SALES_RETURN" as const,
      quantity: D(m.quantity).neg().toFixed(3), unitCost: m.unitCost, value: D(m.value).neg().toFixed(2),
      entryId: inv.entryId, sourceType: "sales_invoice_cancel", sourceId: inv.id, note: `${inv.number} cancelled`, createdBy: p.userId })));
    await tx.update(schema.salesInvoices).set({ status: "CANCELLED", cancelReason: p.reason.trim() }).where(eq(schema.salesInvoices.id, inv.id));
    await audit(tx, { companyId: p.companyId, userId: p.userId, action: "sale.cancel", entityType: "sales_invoice", entityId: inv.id, reason: p.reason.trim() });
    return inv;
  });
}

export async function getInvoice(db: DB, where: { companyId: string; id: string } | { token: string }) {
  const inv = "token" in where
    ? await db.query.salesInvoices.findFirst({ where: eq(schema.salesInvoices.shareToken, where.token) })
    : await db.query.salesInvoices.findFirst({ where: and(eq(schema.salesInvoices.id, where.id), eq(schema.salesInvoices.companyId, where.companyId)) });
  if (!inv) return null;
  const [lines, company, banks] = await Promise.all([
    db.query.salesInvoiceLines.findMany({ where: eq(schema.salesInvoiceLines.invoiceId, inv.id), orderBy: schema.salesInvoiceLines.lineNo }),
    db.query.companies.findFirst({ where: eq(schema.companies.id, inv.companyId) }),
    db.query.bankAccounts.findMany({ where: eq(schema.bankAccounts.companyId, inv.companyId) }),
  ]);
  return { inv, lines, company: company!, bank: banks[0] ?? null };
}

export async function listSales(db: DB, companyId: string, opts: { from?: string; to?: string; q?: string } = {}) {
  return db.query.salesInvoices.findMany({
    where: and(eq(schema.salesInvoices.companyId, companyId), opts.from ? gte(schema.salesInvoices.invoiceDate, opts.from) : undefined,
      opts.to ? lte(schema.salesInvoices.invoiceDate, opts.to) : undefined,
      opts.q ? sql`(${schema.salesInvoices.customerName} ILIKE ${"%" + opts.q + "%"} OR ${schema.salesInvoices.number} ILIKE ${"%" + opts.q + "%"})` : undefined),
    orderBy: [desc(schema.salesInvoices.invoiceDate), desc(schema.salesInvoices.createdAt)], limit: 300 });
}

/** Rates a product was last sold at to this customer, and last purchased at. Helps the owner price consistently. */
export async function lastPrices(db: DB, companyId: string, partyId: string) {
  const r = await db.execute<{ product_id: string; rate: string }>(sql`
    SELECT DISTINCT ON (l.product_id) l.product_id, l.rate FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
    WHERE i.company_id = ${companyId} AND i.party_id = ${partyId} AND i.status = 'ACTIVE' ORDER BY l.product_id, i.invoice_date DESC, i.created_at DESC`);
  return Object.fromEntries(r.rows.map((x) => [x.product_id, x.rate]));
}
