/**
 * "What needs your attention?" — every item comes from live data and says what happened, why it
 * matters, and what to do. Nothing is shown unless the data supports it.
 */
import { findings } from "@/lib/analytics/anomalies";
import { and, eq, sql } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { D, formatINRShort, formatINR } from "@/lib/money";
import { ageing } from "./receivables";
import { stockList } from "./inventory";
import { partyBalances } from "./parties";
import { ledgerHealth } from "@/lib/accounting/reports";
import { todayIST } from "@/lib/dates";

export type Attention = { tone: "bad" | "warn" | "good" | "info"; what: string; why: string; action: string; href: string; cta: string };

const monthStart = (d: string) => d.slice(0, 8) + "01";
const shiftMonth = (d: string, n: number) => { const x = new Date(d + "T00:00:00Z"); x.setUTCMonth(x.getUTCMonth() + n); return x.toISOString().slice(0, 10); };

export async function attentionItems(db: DB, companyId: string): Promise<Attention[]> {
  const today = todayIST();
  const [cust, sup, stock, bal, health] = await Promise.all([ageing(db, companyId, "CUSTOMER", today), ageing(db, companyId, "SUPPLIER", today),
    stockList(db, companyId), partyBalances(db, companyId, "CUSTOMER"), ledgerHealth(db, companyId)]);
  const out: Attention[] = [];

  const bad = health.filter((h) => !h.ok);
  if (bad.length) out.push({ tone: "bad", what: `${bad.length} accounting check${bad.length > 1 ? "s" : ""} failed: ${bad.map((b) => b.name).join(", ")}.`,
    why: "Reports may be wrong until this is fixed.", action: "Open System health and share it with whoever helps you with accounts.", href: "/settings/health", cta: "View" });

  if (cust.buckets.old.gt(0)) out.push({ tone: "info", what: `${formatINRShort(cust.buckets.old)} of old customer balances (from before the app) is still unpaid.`,
    why: "Their bill dates aren't known, so they can't be ranked by lateness.", action: "Import bill-wise dues from Tally (Bills Receivable) for accurate overdue days, or collect as usual.", href: "/customers", cta: "View" });
  if (cust.overdue.gt(0)) {
    const late = cust.parties.filter((p) => p.overdue.gt(0));
    const top = late.slice(0, 3), topSum = top.reduce((s, p) => s.plus(p.overdue), D(0));
    out.push({ tone: cust.buckets.d90.gt(0) || cust.buckets.d61_90.gt(0) ? "bad" : "warn",
      what: `${formatINRShort(cust.overdue)} is overdue from ${late.length} customer${late.length > 1 ? "s" : ""}.`,
      why: late.length > 3 ? `${top.map((p) => p.name).join(", ")} account for ${topSum.div(cust.overdue).mul(100).toFixed(0)}% of it. Money stuck with customers can't pay suppliers or buy stock.`
        : `${top.map((p) => `${p.name} (${formatINRShort(p.overdue)}, ${p.oldest} days)`).join(", ")}.`,
      action: "Start with the first names on the call list.", href: "/customers", cta: "Call list" });
  }

  const over = [...bal.entries()].map(([id, b]) => ({ id, b })).filter(({ b }) => b.balance.gt(0));
  if (over.length) {
    const parties = await db.query.parties.findMany({ where: and(eq(schema.parties.companyId, companyId), eq(schema.parties.type, "CUSTOMER")) });
    const crossed = parties.filter((p) => p.creditLimit && bal.get(p.id)?.balance.gt(p.creditLimit));
    if (crossed.length) out.push({ tone: "warn", what: `${crossed.length} customer${crossed.length > 1 ? "s are" : " is"} over their credit limit: ${crossed.slice(0, 3).map((p) => p.name).join(", ")}${crossed.length > 3 ? "…" : ""}.`,
      why: "More credit to them raises the risk of money not coming back.", action: "Ask for payment before the next credit bill.", href: `/customers/${crossed[0].id}`, cta: "View" });
  }

  const weekDue = sup.parties.reduce((s, p) => s.plus(p.dueSoon), D(0));
  if (sup.overdue.gt(0) || weekDue.gt(0)) out.push({ tone: sup.overdue.gt(0) ? "warn" : "info",
    what: [sup.overdue.gt(0) && `${formatINRShort(sup.overdue)} overdue to suppliers`, weekDue.gt(0) && `${formatINRShort(weekDue)} due to suppliers this week`].filter(Boolean).join("; ") + ".",
    why: "Late supplier payments can cost you credit terms and schemes.", action: "Plan these payments against expected collections.", href: "/suppliers", cta: "View" });

  const active = stock.filter((s) => s.isActive);
  const low = active.filter((s) => s.status === "LOW" || s.status === "OUT");
  if (low.length) out.push({ tone: active.some((s) => s.status === "OUT") ? "warn" : "info",
    what: `${low.length} product${low.length > 1 ? "s are" : " is"} low or out of stock: ${low.slice(0, 3).map((s) => s.name).join(", ")}${low.length > 3 ? "…" : ""}.`,
    why: "You may miss sales if customers ask for these.", action: "Reorder from your supplier.", href: "/inventory?show=low", cta: "View stock" });

  const oldOpen = await db.query.financialPeriods.findMany({ where: and(eq(schema.financialPeriods.companyId, companyId), eq(schema.financialPeriods.isClosed, false)) });
  const sixMonthsAgo = new Date(Date.parse(today + "T00:00:00Z") - 183 * 86400000).toISOString().slice(0, 10);
  const stale = oldOpen.filter((p) => p.endDate < sixMonthsAgo);
  if (stale.length) out.push({ tone: "info", what: `${stale.map((p) => p.name).join(", ")} ended over six months ago and is still open.`,
    why: "Anything dated in it can still be changed by mistake, which would change figures you've already filed.", action: "If its returns are filed, lock it.", href: "/settings/years", cta: "Lock" });

  const unconfirmed = active.filter((s) => s.gstRateStatus !== "USER_CONFIRMED").length;
  if (unconfirmed) out.push({ tone: "info", what: `${unconfirmed} product${unconfirmed > 1 ? "s have" : " has"} a GST rate that isn't confirmed.`,
    why: "A wrong rate means wrong GST on every bill for that product.", action: "Compare with your supplier's GST bill for the same item (it shows HSN and rate), then confirm.", href: "/inventory", cta: "Review" });
  const odd = (await findings(db, companyId, today)).open;
  const serious = odd.filter((f) => f.tone === "bad");
  if (odd.length) out.push({ tone: serious.length ? "warn" : "info", what: `${odd.length} thing${odd.length > 1 ? "s look" : " looks"} unusual${serious.length ? ` (${serious.length} to check now)` : ""}: ${odd[0].what}`,
    why: "Possible duplicates, sales below cost, large cash or back-dated entries.", action: "Check each one, or mark it fine.", href: "/assistant/checks", cta: "Check" });
  return out;
}

/** Month-to-date sales and profit vs the same days last month, with the biggest movers. Only facts, no guessing why. */
export async function salesChange(db: DB, companyId: string) {
  const today = todayIST(), from = monthStart(today), day = Number(today.slice(8, 10));
  const lastFrom = shiftMonth(from, -1), lastTo = shiftMonth(from, -1).slice(0, 8) + String(Math.min(day, 28)).padStart(2, "0");
  const q = (a: string, b: string) => db.execute<{ brand: string | null; sales: string; cost: string }>(sql`
    SELECT b.name AS brand, coalesce(sum(l.taxable),0) AS sales, coalesce(sum(l.cost_value),0) AS cost
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN products p ON p.id = l.product_id LEFT JOIN brands b ON b.id = p.brand_id
    WHERE i.company_id = ${companyId} AND i.status = 'ACTIVE' AND i.invoice_date BETWEEN ${a} AND ${b} GROUP BY b.name`);
  const [now, prev] = await Promise.all([q(from, today), q(lastFrom, lastTo)]);
  const tot = (r: typeof now) => r.rows.reduce((s, x) => ({ sales: s.sales.plus(x.sales), profit: s.profit.plus(x.sales).minus(x.cost) }), { sales: D(0), profit: D(0) });
  const n = tot(now), p = tot(prev);
  const brands = [...new Set([...now.rows, ...prev.rows].map((r) => r.brand ?? "No brand"))].map((b) => ({
    brand: b, now: D(now.rows.find((r) => (r.brand ?? "No brand") === b)?.sales ?? 0), prev: D(prev.rows.find((r) => (r.brand ?? "No brand") === b)?.sales ?? 0) }))
    .map((x) => ({ ...x, change: x.now.minus(x.prev) })).sort((a, b) => b.change.abs().comparedTo(a.change.abs()));
  return { now: n, prev: p, days: day, brands, hasData: n.sales.gt(0) || p.sales.gt(0), fmt: formatINR };
}
