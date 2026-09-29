/**
 * Stock intelligence. Every figure is labelled:
 *   ACTUAL   — counted from records (stock on hand, units sold, last sale date, age)
 *   ESTIMATE — worked out from actuals with a stated assumption (average daily sales, days of stock left)
 *   FORECAST — a suggestion about the future (reorder point, quantity to order)
 * Forecasts are only made with enough sales history; otherwise the owner's own reorder level is used.
 */
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB } from "@/db";
import { D } from "@/lib/money";
import { todayIST } from "@/lib/dates";

export type ReorderSettings = { leadDays: number; coverDays: number; safetyDays: number; lookbackDays: number };
export const DEFAULT_REORDER: ReorderSettings = { leadDays: 7, coverDays: 30, safetyDays: 5, lookbackDays: 90 };
const MIN_SALE_DAYS = 3, MIN_HISTORY_DAYS = 21;

export async function reorderSettings(db: DB, companyId: string): Promise<ReorderSettings> {
  const r = await db.execute<{ value: Partial<ReorderSettings> }>(sql`SELECT value FROM settings WHERE company_id = ${companyId} AND key = 'reorder'`);
  return { ...DEFAULT_REORDER, ...(r.rows[0]?.value ?? {}) };
}
export async function saveReorderSettings(db: DB, companyId: string, s: ReorderSettings) {
  for (const [k, v] of Object.entries(s)) if (!Number.isInteger(v) || v < 0 || v > 365) throw new Error(`Invalid ${k}`);
  await db.insert(schema.settings).values({ companyId, key: "reorder", value: s })
    .onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value: s } });
}

export type Health = "OUT" | "LOW" | "HEALTHY" | "OVERSTOCK" | "SLOW" | "DEAD" | "NEW";
export type StockInsight = {
  id: string; name: string; brand: string | null; unit: string;
  qty: Decimal; value: Decimal; soldQty: Decimal; saleDays: number; lastSold: string | null; firstSeen: string | null; oldestUnitDays: number | null;
  avgDaily: Decimal | null; daysLeft: Decimal | null; recentVsUsual: Decimal | null;
  reorderPoint: Decimal | null; suggestQty: Decimal | null; basis: "FORECAST" | "YOUR_REORDER_LEVEL" | "NONE"; enoughHistory: boolean;
  health: Health; note: string;
};

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);

export async function stockInsights(db: DB, companyId: string, asOf = todayIST()) {
  const s = await reorderSettings(db, companyId);
  const from = new Date(Date.parse(asOf + "T00:00:00Z") - (s.lookbackDays - 1) * 86400000).toISOString().slice(0, 10);
  const recentFrom = new Date(Date.parse(asOf + "T00:00:00Z") - 29 * 86400000).toISOString().slice(0, 10);
  const rows = await db.execute<{ id: string; name: string; brand: string | null; unit: string; reorder_level: string | null; qty: string; value: string;
    sold: string; sold_recent: string; sale_days: number; last_sold: string | null; first_seen: string | null }>(sql`
    SELECT p.id, p.name, b.name AS brand, p.unit, p.reorder_level,
      coalesce(sum(t.quantity) FILTER (WHERE t.txn_date <= ${asOf}),0) AS qty, coalesce(sum(t.value) FILTER (WHERE t.txn_date <= ${asOf}),0) AS value,
      coalesce(-sum(t.quantity) FILTER (WHERE t.type IN ('SALE','SALES_RETURN') AND t.txn_date BETWEEN ${from} AND ${asOf}),0) AS sold,
      coalesce(-sum(t.quantity) FILTER (WHERE t.type IN ('SALE','SALES_RETURN') AND t.txn_date BETWEEN ${recentFrom} AND ${asOf}),0) AS sold_recent,
      count(DISTINCT t.txn_date) FILTER (WHERE t.type = 'SALE' AND t.txn_date BETWEEN ${from} AND ${asOf})::int AS sale_days,
      max(t.txn_date) FILTER (WHERE t.type = 'SALE' AND t.txn_date <= ${asOf}) AS last_sold,
      min(t.txn_date) AS first_seen
    FROM products p LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN inventory_transactions t ON t.product_id = p.id
    WHERE p.company_id = ${companyId} AND p.is_active GROUP BY p.id, b.name ORDER BY p.name`);

  // Age of what's on the shelf: walk stock-ins newest first until current quantity is covered (FIFO view of age).
  const ins = await db.execute<{ product_id: string; txn_date: string; quantity: string }>(sql`
    SELECT product_id, txn_date, quantity FROM inventory_transactions
    WHERE company_id = ${companyId} AND quantity > 0 AND txn_date <= ${asOf} ORDER BY product_id, txn_date DESC, created_at DESC`);
  const inBy = new Map<string, { d: string; q: Decimal }[]>();
  for (const x of ins.rows) (inBy.get(x.product_id) ?? inBy.set(x.product_id, []).get(x.product_id)!).push({ d: x.txn_date, q: D(x.quantity) });

  const out: StockInsight[] = rows.rows.map((r) => {
    const qty = D(r.qty), value = D(r.value), sold = D(r.sold), recent = D(r.sold_recent);
    const history = r.first_seen ? Math.min(daysBetween(r.first_seen, asOf) + 1, s.lookbackDays) : 0;
    const enoughHistory = r.sale_days >= MIN_SALE_DAYS && history >= MIN_HISTORY_DAYS;
    const avgDaily = history > 0 && sold.gt(0) ? sold.div(history) : null;
    const daysLeft = avgDaily && avgDaily.gt(0) ? qty.div(avgDaily).toDecimalPlaces(0, Decimal.ROUND_DOWN) : null;
    const usualDaily = avgDaily, recentDaily = recent.div(Math.min(30, history || 30));
    const recentVsUsual = usualDaily && usualDaily.gt(0) && history >= 45 ? recentDaily.div(usualDaily) : null;
    let left = qty, oldest: string | null = null;
    for (const x of inBy.get(r.id) ?? []) { if (left.lte(0)) break; oldest = x.d; left = left.minus(x.q); }
    const oldestUnitDays = qty.gt(0) && oldest ? daysBetween(oldest, asOf) : null;

    let reorderPoint: Decimal | null = null, suggestQty: Decimal | null = null, basis: StockInsight["basis"] = "NONE";
    if (enoughHistory && avgDaily) {
      basis = "FORECAST";
      const safety = avgDaily.mul(s.safetyDays);
      reorderPoint = avgDaily.mul(s.leadDays).plus(safety).toDecimalPlaces(0, Decimal.ROUND_UP);
      const target = avgDaily.mul(s.leadDays + s.coverDays).plus(safety);
      suggestQty = qty.lte(reorderPoint) ? Decimal.max(target.minus(qty), 0).toDecimalPlaces(0, Decimal.ROUND_UP) : null;
    } else if (r.reorder_level) {
      basis = "YOUR_REORDER_LEVEL"; reorderPoint = D(r.reorder_level);
    }

    const sinceSale = r.last_sold ? daysBetween(r.last_sold, asOf) : null;
    let health: Health, note: string;
    if (qty.lte(0)) { health = "OUT"; note = sold.gt(0) ? "Out of stock, and it has been selling." : "Out of stock."; }
    else if (history < MIN_HISTORY_DAYS && sold.isZero()) { health = "NEW"; note = "Too new to judge."; }
    else if (sinceSale === null ? history >= 60 : sinceSale >= 90) { health = "DEAD"; note = sinceSale === null ? `Not sold at all in the last ${history} days.` : `Last sold ${sinceSale} days ago.`; }
    else if (reorderPoint && qty.lte(reorderPoint)) { health = "LOW"; note = daysLeft ? `About ${daysLeft} days of stock left at the usual pace.` : "At or below your reorder level."; }
    else if (daysLeft && daysLeft.gt(s.coverDays * 3)) { health = "OVERSTOCK"; note = `About ${daysLeft} days of stock — more than ${s.coverDays * 3} days' worth.`; }
    else if (sinceSale !== null && sinceSale >= 45) { health = "SLOW"; note = `Last sold ${sinceSale} days ago.`; }
    else { health = "HEALTHY"; note = daysLeft ? `About ${daysLeft} days of stock left.` : "Stock looks fine."; }
    if (recentVsUsual && recentVsUsual.gte(1.3) && health !== "OUT") note += ` Selling faster than usual (${recentVsUsual.mul(100).minus(100).toFixed(0)}% more in the last 30 days).`;

    return { id: r.id, name: r.name, brand: r.brand, unit: r.unit, qty, value, soldQty: sold, saleDays: r.sale_days, lastSold: r.last_sold, firstSeen: r.first_seen,
      oldestUnitDays, avgDaily: avgDaily?.toDecimalPlaces(2) ?? null, daysLeft, recentVsUsual, reorderPoint, suggestQty, basis, enoughHistory, health, note };
  });
  const sumV = (h: Health[]) => out.filter((x) => h.includes(x.health)).reduce((a, x) => a.plus(x.value), D(0));
  return { items: out, settings: s, lookbackFrom: from,
    summary: { total: out.reduce((a, x) => a.plus(x.value), D(0)), slowValue: sumV(["SLOW", "DEAD"]), overValue: sumV(["OVERSTOCK"]),
      counts: Object.fromEntries((["OUT", "LOW", "HEALTHY", "OVERSTOCK", "SLOW", "DEAD", "NEW"] as Health[]).map((h) => [h, out.filter((x) => x.health === h).length])) as Record<Health, number> } };
}
