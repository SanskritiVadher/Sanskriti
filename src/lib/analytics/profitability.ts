/**
 * Where is the money made? Sales and gross profit (sales value − cost of the goods sold, at the cost they
 * actually left stock at) by product, brand, customer and salesperson, net of returns.
 */
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import type { DB } from "@/db";
import { D } from "@/lib/money";

export type By = "product" | "brand" | "customer" | "salesperson";
export type ProfitRow = { id: string; name: string; sales: Decimal; cost: Decimal; profit: Decimal; margin: Decimal | null; qty: Decimal; bills: number; share: Decimal; flag: string | null };

const GROUP = {
  product: { id: sql`p.id::text`, name: sql`max(p.name)`, by: sql`p.id` },
  brand: { id: sql`coalesce(b.id::text, 'none')`, name: sql`coalesce(max(b.name), 'No brand')`, by: sql`b.id` },
  customer: { id: sql`i.party_id::text`, name: sql`max(i.customer_name)`, by: sql`i.party_id` },
  salesperson: { id: sql`i.created_by::text`, name: sql`max(u.name)`, by: sql`i.created_by` },
} as const;

export async function profitability(db: DB, companyId: string, from: string, to: string, by: By) {
  const g = GROUP[by];
  // Invoice lines add; credit-note lines (returns) subtract, attributed to the invoice they came from.
  const r = await db.execute<{ id: string; name: string; sales: string; cost: string; qty: string; bills: number }>(sql`
    WITH lines AS (
      SELECT l.invoice_id AS inv_id, true AS is_sale, l.product_id, l.taxable AS sales, l.cost_value AS cost, l.quantity AS qty
      FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
      WHERE i.company_id = ${companyId} AND i.status = 'ACTIVE' AND i.invoice_date BETWEEN ${from} AND ${to}
      UNION ALL
      SELECT n.invoice_id, false, nl.product_id, -nl.taxable, -nl.cost_value, -nl.quantity
      FROM gst_note_lines nl JOIN gst_notes n ON n.id = nl.note_id
      WHERE n.company_id = ${companyId} AND n.kind = 'CREDIT_NOTE' AND n.note_date BETWEEN ${from} AND ${to})
    SELECT ${g.id} AS id, ${g.name} AS name, sum(x.sales) AS sales, sum(x.cost) AS cost, sum(x.qty) AS qty,
      count(DISTINCT CASE WHEN x.is_sale THEN x.inv_id END)::int AS bills
    FROM lines x JOIN sales_invoices i ON i.id = x.inv_id JOIN products p ON p.id = x.product_id
      LEFT JOIN brands b ON b.id = p.brand_id LEFT JOIN users u ON u.id = i.created_by
    GROUP BY ${g.by}`);
  const rows = r.rows.map((x) => ({ id: x.id, name: x.name, sales: D(x.sales), cost: D(x.cost), qty: D(x.qty), bills: x.bills }));
  const totSales = rows.reduce((s, x) => s.plus(x.sales), D(0));
  const totProfit = rows.reduce((s, x) => s.plus(x.sales).minus(x.cost), D(0));
  const avgMargin = totSales.isZero() ? null : totProfit.div(totSales).mul(100);
  const avgSales = rows.length ? totSales.div(rows.length) : D(0);
  const bills = rows.map((x) => x.bills).sort((a, b) => a - b);
  const medianBills = bills[Math.floor(bills.length / 2)] ?? 0;
  const out: ProfitRow[] = rows.map((x) => {
    const profit = x.sales.minus(x.cost), margin = x.sales.isZero() ? null : profit.div(x.sales).mul(100);
    const low = !!(avgMargin && margin && margin.lt(avgMargin.mul(0.6)));
    let flag: string | null = null;
    if (profit.lt(0)) flag = "Losing money";
    else if (low && x.sales.gt(avgSales)) flag = by === "customer" ? "High sales but low margin" : "Sells well but low margin";
    else if (low && by === "product" && x.bills >= medianBills && rows.length > 2) flag = "Sells often but low margin";
    else if (low) flag = "Below-average margin";
    else if (avgMargin && margin && rows.length > 2 && margin.gt(avgMargin.mul(1.3))) flag = "Better than average margin";
    return { ...x, profit, margin, share: totProfit.isZero() ? D(0) : profit.div(totProfit).mul(100), flag };
  }).sort((a, b) => b.profit.comparedTo(a.profit));
  return { rows: out, totSales, totProfit, avgMargin };
}
