/**
 * Products and stock. Stock quantity and value are always SUM(inventory_transactions); nothing is cached.
 * Valuation: weighted average cost (company default). Every movement that changes stock value posts a
 * balanced journal entry in the same database transaction, so Stock-in-hand in the ledger always equals
 * the value of stock on hand.
 */
import { and, eq, sql, asc, desc } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB, type Tx } from "@/db";
import { D, toDb } from "@/lib/money";
import { UserFacingError } from "@/lib/errors";
import { postEntryTx, LedgerError } from "@/lib/accounting/engine";
import { audit } from "./audit";
import { todayIST } from "@/lib/dates";

export type ProductInput = {
  name: string; sku?: string; brandId?: string; categoryName?: string; hsn?: string; gstRate?: string; gstConfirmed?: boolean;
  unit?: string; purchasePrice?: string; dealerPrice?: string; wholesalePrice?: string; retailPrice?: string; mrp?: string;
  minSellingPrice?: string; reorderLevel?: string; trackSerial?: boolean; warrantyMonths?: string;
};

const clean = (v?: string) => (v ?? "").trim() || null;
const moneyOrNull = (v: string | undefined, label: string, field: string) => {
  const s = clean(v)?.replace(/[,₹\s]/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new UserFacingError(`${label} should be an amount like 4500 or 4500.50.`, field);
  return toDb(s);
};
const qtyOrNull = (v: string | undefined, label: string, field: string) => {
  const s = clean(v)?.replace(/,/g, "");
  if (!s) return null;
  if (!/^\d+(\.\d{1,3})?$/.test(s)) throw new UserFacingError(`${label} should be a number.`, field);
  return D(s).toFixed(3);
};

/** Short, readable SKU from name: "SF Sonic 35Ah" -> "SFSONIC-35AH". */
export function suggestSku(name: string) {
  return name.toUpperCase().replace(/[^A-Z0-9 ]/g, "").trim().split(/\s+/).slice(0, 4).join("-").slice(0, 24) || "ITEM";
}

export async function validateProduct(db: DB | Tx, companyId: string, input: ProductInput, exceptId?: string) {
  const name = input.name?.trim();
  if (!name) throw new UserFacingError("Please enter the product name.", "name");
  const sku = (clean(input.sku) ?? suggestSku(name)).toUpperCase();
  const dupName = await db.query.products.findFirst({ where: and(eq(schema.products.companyId, companyId), sql`lower(${schema.products.name}) = lower(${name})`) });
  if (dupName && dupName.id !== exceptId) throw new UserFacingError(`"${dupName.name}" already exists.`, "name");
  const dupSku = await db.query.products.findFirst({ where: and(eq(schema.products.companyId, companyId), eq(schema.products.sku, sku)) });
  if (dupSku && dupSku.id !== exceptId) throw new UserFacingError(`Code ${sku} is already used by "${dupSku.name}". Use a different code.`, "sku");
  const hsn = clean(input.hsn);
  if (hsn && !/^\d{4}(\d{2})?(\d{2})?$/.test(hsn)) throw new UserFacingError("HSN should be 4, 6 or 8 digits.", "hsn");
  const rate = clean(input.gstRate);
  if (rate && !/^\d{1,2}(\.\d{1,2})?$/.test(rate)) throw new UserFacingError("GST rate should be a percentage like 18.", "gstRate");
  if (rate && D(rate).gt(40)) throw new UserFacingError("GST rate looks too high. Please check.", "gstRate");
  if (input.brandId) {
    const b = await db.query.brands.findFirst({ where: and(eq(schema.brands.id, input.brandId), eq(schema.brands.companyId, companyId)) });
    if (!b) throw new UserFacingError("Please choose a valid brand.", "brandId");
  }
  const w = clean(input.warrantyMonths);
  if (w && !/^\d{1,3}$/.test(w)) throw new UserFacingError("Warranty should be months, like 24.", "warrantyMonths");
  return {
    name, sku, brandId: input.brandId || null, hsn, gstRate: rate ? D(rate).toFixed(2) : null,
    // A rate is only "confirmed" if the owner ticks it. Phase 5 adds source-checked GST rules.
    gstRateStatus: (rate && input.gstConfirmed ? "USER_CONFIRMED" : "UNVERIFIED") as "USER_CONFIRMED" | "UNVERIFIED",
    unit: clean(input.unit)?.toLowerCase() ?? "pcs",
    purchasePrice: moneyOrNull(input.purchasePrice, "Purchase price", "purchasePrice"),
    dealerPrice: moneyOrNull(input.dealerPrice, "Dealer price", "dealerPrice"),
    wholesalePrice: moneyOrNull(input.wholesalePrice, "Wholesale price", "wholesalePrice"),
    retailPrice: moneyOrNull(input.retailPrice, "Retail price", "retailPrice"),
    mrp: moneyOrNull(input.mrp, "MRP", "mrp"),
    minSellingPrice: moneyOrNull(input.minSellingPrice, "Minimum selling price", "minSellingPrice"),
    reorderLevel: qtyOrNull(input.reorderLevel, "Reorder level", "reorderLevel"),
    trackSerial: !!input.trackSerial, warrantyMonths: w ? Number(w) : null,
  };
}

async function categoryId(tx: Tx, companyId: string, name?: string) {
  const n = clean(name);
  if (!n) return null;
  const found = await tx.query.categories.findFirst({ where: and(eq(schema.categories.companyId, companyId), sql`lower(${schema.categories.name}) = lower(${n})`) });
  if (found) return found.id;
  const [c] = await tx.insert(schema.categories).values({ companyId, name: n }).returning();
  return c.id;
}

async function defaultWarehouse(tx: Tx, companyId: string) {
  const w = await tx.query.warehouses.findFirst({ where: and(eq(schema.warehouses.companyId, companyId), eq(schema.warehouses.isDefault, true)) });
  if (!w) throw new Error("No default godown");
  return w;
}

export async function createProduct(db: DB, companyId: string, userId: string,
  input: ProductInput & { openingQty?: string; openingRate?: string; openingDate?: string }) {
  return db.transaction(async (tx) => {
    const v = await validateProduct(tx, companyId, input);
    const [p] = await tx.insert(schema.products).values({ companyId, ...v, categoryId: await categoryId(tx, companyId, input.categoryName) }).returning();
    await audit(tx, { companyId, userId, action: "product.create", entityType: "product", entityId: p.id, after: p });
    const oq = qtyOrNull(input.openingQty, "Opening stock", "openingQty");
    if (oq && D(oq).gt(0)) {
      const rate = moneyOrNull(input.openingRate, "Opening stock rate", "openingRate") ?? v.purchasePrice;
      if (!rate) throw new UserFacingError("Enter the cost per unit for the opening stock (or a purchase price).", "openingRate");
      await addStockTx(tx, { companyId, userId, productId: p.id, qty: oq, unitCost: rate, date: input.openingDate || todayIST(),
        type: "OPENING", voucherType: "OPENING", sourceType: "opening_stock", note: "Opening stock",
        counterKey: "OPENING_BALANCE_EQUITY" });
    }
    return p;
  });
}

export async function updateProduct(db: DB, companyId: string, userId: string, id: string, input: ProductInput & { isActive?: boolean }) {
  return db.transaction(async (tx) => {
    const before = await tx.query.products.findFirst({ where: and(eq(schema.products.id, id), eq(schema.products.companyId, companyId)) });
    if (!before) throw new UserFacingError("Product not found.");
    const v = await validateProduct(tx, companyId, input, id);
    const [after] = await tx.update(schema.products).set({ ...v, categoryId: await categoryId(tx, companyId, input.categoryName),
      isActive: input.isActive ?? before.isActive, updatedAt: new Date() }).where(eq(schema.products.id, id)).returning();
    await audit(tx, { companyId, userId, action: "product.update", entityType: "product", entityId: id, before, after });
    return after;
  });
}

/** Current quantity, value and average cost of one product (optionally as of a date). */
export async function stockOf(q: DB | Tx, productId: string, asOf = "9999-12-31") {
  const [r] = await q.select({ qty: sql<string>`coalesce(sum(${schema.inventoryTransactions.quantity}),0)`, value: sql<string>`coalesce(sum(${schema.inventoryTransactions.value}),0)` })
    .from(schema.inventoryTransactions).where(and(eq(schema.inventoryTransactions.productId, productId), sql`${schema.inventoryTransactions.txnDate} <= ${asOf}`));
  const qty = D(r.qty), value = D(r.value);
  return { qty, value, avgCost: qty.gt(0) ? value.div(qty) : D(0) };
}

type AddStock = { companyId: string; userId: string; productId: string; qty: string; unitCost: string; date: string;
  type: "OPENING" | "ADJUSTMENT_IN"; voucherType: "OPENING" | "STOCK_ADJUSTMENT"; sourceType: string; note?: string; counterKey: string };

/** Stock in at a known cost: Dr Stock-in-hand, Cr counter account. */
async function addStockTx(tx: Tx, a: AddStock) {
  const product = await tx.execute(sql`SELECT id FROM products WHERE id = ${a.productId} FOR UPDATE`); // serialise per product
  if (!product.rows.length) throw new UserFacingError("Product not found.");
  const q = D(a.qty), value = toDb(q.mul(a.unitCost));
  const wh = await defaultWarehouse(tx, a.companyId);
  const p = await tx.query.products.findFirst({ where: eq(schema.products.id, a.productId) });
  const entry = await postEntryTx(tx, { companyId: a.companyId, userId: a.userId, voucherType: a.voucherType, date: a.date,
    narration: `${a.note ?? "Stock in"}: ${p!.name} × ${q.toString()}`, sourceType: a.sourceType, sourceId: a.productId,
    lines: [{ systemKey: "INVENTORY", debit: value }, { systemKey: a.counterKey, credit: value }] });
  await tx.insert(schema.inventoryTransactions).values({ companyId: a.companyId, productId: a.productId, warehouseId: wh.id, txnDate: a.date,
    type: a.type, quantity: q.toFixed(3), unitCost: D(a.unitCost).toFixed(4), value, entryId: entry.id, sourceType: a.sourceType,
    note: a.note ?? null, createdBy: a.userId });
  return entry;
}

export const ADJUST_REASONS = {
  DAMAGED: { label: "Damaged / scrapped", dir: -1, key: "STOCK_ADJUSTMENT" },
  LOST: { label: "Lost / missing", dir: -1, key: "STOCK_ADJUSTMENT" },
  COUNT_LESS: { label: "Physical count is less", dir: -1, key: "STOCK_ADJUSTMENT" },
  OWN_USE: { label: "Taken for personal / home use", dir: -1, key: "DRAWINGS" },
  COUNT_MORE: { label: "Physical count is more", dir: 1, key: "STOCK_ADJUSTMENT" },
  FOUND: { label: "Found / returned to stock", dir: 1, key: "STOCK_ADJUSTMENT" },
} as const;
export type AdjustReason = keyof typeof ADJUST_REASONS;

/**
 * Correct stock. Reductions are valued at current average cost (Dr Stock adjustments, Cr Stock-in-hand).
 * Increases use the current average cost, or a cost the owner enters when there is no stock to average.
 */
export async function adjustStock(db: DB, a: { companyId: string; userId: string; productId: string; reason: AdjustReason; qty: string; date: string; note?: string; unitCost?: string }) {
  const r = ADJUST_REASONS[a.reason];
  if (!r) throw new UserFacingError("Choose a reason.", "reason");
  const qs = (a.qty ?? "").replace(/,/g, "").trim();
  if (!/^\d+(\.\d{1,3})?$/.test(qs) || D(qs).lte(0)) throw new UserFacingError("Enter a quantity greater than zero.", "qty");
  const q = D(qs);
  return db.transaction(async (tx) => {
    const lock = await tx.execute(sql`SELECT id, name FROM products WHERE id = ${a.productId} AND company_id = ${a.companyId} FOR UPDATE`);
    if (!lock.rows.length) throw new UserFacingError("Product not found.");
    const name = (lock.rows[0] as { name: string }).name;
    const cur = await stockOf(tx, a.productId);
    const wh = await defaultWarehouse(tx, a.companyId);
    const note = [r.label, a.note?.trim()].filter(Boolean).join(" — ");
    if (r.dir < 0) {
      if (q.gt(cur.qty)) throw new LedgerError(`Only ${cur.qty.toString()} in stock; you can't remove ${q.toString()}.`, "qty");
      // Taking out everything takes out exactly the remaining value (no paise left behind).
      const value = q.eq(cur.qty) ? cur.value : D(toDb(q.mul(cur.avgCost)));
      const entry = value.gt(0) ? await postEntryTx(tx, { companyId: a.companyId, userId: a.userId, voucherType: "STOCK_ADJUSTMENT", date: a.date,
        narration: `Stock reduced: ${name} × ${q.toString()} (${note})`, sourceType: "stock_adjustment", sourceId: a.productId,
        lines: [{ systemKey: r.key, debit: value.toFixed(2) }, { systemKey: "INVENTORY", credit: value.toFixed(2) }] }) : null;
      await tx.insert(schema.inventoryTransactions).values({ companyId: a.companyId, productId: a.productId, warehouseId: wh.id, txnDate: a.date,
        type: "ADJUSTMENT_OUT", quantity: q.neg().toFixed(3), unitCost: cur.avgCost.toFixed(4), value: value.neg().toFixed(2),
        entryId: entry?.id ?? null, sourceType: "stock_adjustment", note, createdBy: a.userId });
      await audit(tx, { companyId: a.companyId, userId: a.userId, action: "stock.adjust", entityType: "product", entityId: a.productId, after: { reason: a.reason, qty: `-${q}`, value: value.toFixed(2) }, reason: note });
      return entry;
    }
    let cost: Decimal;
    if (cur.qty.gt(0)) cost = cur.avgCost;
    else {
      const c = (a.unitCost ?? "").replace(/[,₹\s]/g, "");
      if (!/^\d+(\.\d{1,2})?$/.test(c) || D(c).lte(0)) throw new LedgerError("There's no stock to take a cost from. Enter the cost per unit.", "unitCost");
      cost = D(c);
    }
    const e = await addStockTx(tx, { companyId: a.companyId, userId: a.userId, productId: a.productId, qty: q.toFixed(3), unitCost: cost.toFixed(4),
      date: a.date, type: "ADJUSTMENT_IN", voucherType: "STOCK_ADJUSTMENT", sourceType: "stock_adjustment", note, counterKey: "STOCK_ADJUSTMENT" });
    await audit(tx, { companyId: a.companyId, userId: a.userId, action: "stock.adjust", entityType: "product", entityId: a.productId, after: { reason: a.reason, qty: `+${q}` }, reason: note });
    return e;
  });
}

export type StockRow = {
  id: string; name: string; sku: string; brand: string | null; category: string | null; unit: string; isActive: boolean;
  qty: Decimal; value: Decimal; avgCost: Decimal; reorderLevel: Decimal | null; status: "OUT" | "LOW" | "OK" | "NEGATIVE";
  gstRate: string | null; gstRateStatus: string; hsn: string | null; dealerPrice: string | null; retailPrice: string | null; purchasePrice: string | null;
  lastMovement: string | null;
};

export async function stockList(db: DB, companyId: string, opts: { q?: string; brandId?: string } = {}): Promise<StockRow[]> {
  const rows = await db.execute<{
    id: string; name: string; sku: string; brand: string | null; category: string | null; unit: string; is_active: boolean;
    qty: string; value: string; reorder_level: string | null; gst_rate: string | null; gst_rate_status: string; hsn: string | null;
    dealer_price: string | null; retail_price: string | null; purchase_price: string | null; last_movement: string | null;
  }>(sql`
    SELECT p.id, p.name, p.sku, b.name AS brand, c.name AS category, p.unit, p.is_active, p.reorder_level, p.gst_rate, p.gst_rate_status, p.hsn,
      p.dealer_price, p.retail_price, p.purchase_price,
      coalesce(sum(t.quantity),0) AS qty, coalesce(sum(t.value),0) AS value, max(t.txn_date) AS last_movement
    FROM products p
    LEFT JOIN brands b ON b.id = p.brand_id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN inventory_transactions t ON t.product_id = p.id
    WHERE p.company_id = ${companyId}
      ${opts.q ? sql`AND (p.name ILIKE ${"%" + opts.q + "%"} OR p.sku ILIKE ${"%" + opts.q + "%"})` : sql``}
      ${opts.brandId ? sql`AND p.brand_id = ${opts.brandId}` : sql``}
    GROUP BY p.id, b.name, c.name
    ORDER BY p.is_active DESC, b.name NULLS LAST, p.name
    LIMIT 1000`);
  return rows.rows.map((r) => {
    const qty = D(r.qty), value = D(r.value), rl = r.reorder_level ? D(r.reorder_level) : null;
    const status = qty.lt(0) ? "NEGATIVE" : qty.isZero() ? "OUT" : rl && qty.lte(rl) ? "LOW" : "OK";
    return { id: r.id, name: r.name, sku: r.sku, brand: r.brand, category: r.category, unit: r.unit, isActive: r.is_active,
      qty, value, avgCost: qty.gt(0) ? value.div(qty) : D(0), reorderLevel: rl, status, gstRate: r.gst_rate, gstRateStatus: r.gst_rate_status,
      hsn: r.hsn, dealerPrice: r.dealer_price, retailPrice: r.retail_price, purchasePrice: r.purchase_price, lastMovement: r.last_movement };
  });
}

export async function productMovements(db: DB, companyId: string, productId: string) {
  return db.select({ id: schema.inventoryTransactions.id, date: schema.inventoryTransactions.txnDate, type: schema.inventoryTransactions.type,
    qty: schema.inventoryTransactions.quantity, unitCost: schema.inventoryTransactions.unitCost, value: schema.inventoryTransactions.value,
    note: schema.inventoryTransactions.note, entryId: schema.inventoryTransactions.entryId })
    .from(schema.inventoryTransactions)
    .where(and(eq(schema.inventoryTransactions.companyId, companyId), eq(schema.inventoryTransactions.productId, productId)))
    .orderBy(desc(schema.inventoryTransactions.txnDate), desc(schema.inventoryTransactions.createdAt)).limit(200);
}

/** Stock value from movements vs Stock-in-hand in the ledger. Must match exactly. */
export async function inventoryReconciliation(db: DB, companyId: string) {
  const [inv] = await db.select({ v: sql<string>`coalesce(sum(${schema.inventoryTransactions.value}),0)` })
    .from(schema.inventoryTransactions).where(eq(schema.inventoryTransactions.companyId, companyId));
  const r = await db.execute<{ v: string }>(sql`
    SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id
    WHERE l.company_id = ${companyId} AND a.system_key = 'INVENTORY'`);
  const stock = D(inv.v), ledger = D(r.rows[0].v);
  return { stock, ledger, ok: stock.eq(ledger), difference: stock.minus(ledger) };
}

export async function listBrands(db: DB, companyId: string) {
  return db.query.brands.findMany({ where: eq(schema.brands.companyId, companyId), orderBy: asc(schema.brands.name) });
}
export async function listCategories(db: DB, companyId: string) {
  return db.query.categories.findMany({ where: eq(schema.categories.companyId, companyId), orderBy: asc(schema.categories.name) });
}
