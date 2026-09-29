/**
 * Daily brief and weekly review — short, from live data, each line with a place to act.
 * They are pages (and a WhatsApp-ready text the owner can send to himself); nothing is sent automatically.
 */
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import type { DB } from "@/db";
import { D, formatINRShort } from "@/lib/money";
import { todayIST, fmtDate } from "@/lib/dates";
import { moneyPosition } from "@/lib/accounting/reports";
import { ageing } from "./receivables";
import { stockInsights } from "@/lib/analytics/stock";
import { findings } from "@/lib/analytics/anomalies";
import { profitability } from "@/lib/analytics/profitability";

const shift = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

async function flows(db: DB, companyId: string, from: string, to: string) {
  const r = await db.execute<{ sales: string; bills: number; received: string; paid: string; collected: string; expenses: string }>(sql`
    SELECT
      (SELECT coalesce(sum(total),0) FROM sales_invoices WHERE company_id = ${companyId} AND status='ACTIVE' AND invoice_date BETWEEN ${from} AND ${to}) sales,
      (SELECT count(*)::int FROM sales_invoices WHERE company_id = ${companyId} AND status='ACTIVE' AND invoice_date BETWEEN ${from} AND ${to}) bills,
      (SELECT coalesce(sum(l.debit - l.credit) FILTER (WHERE l.debit > 0),0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.id = a.group_id
        WHERE l.company_id = ${companyId} AND e.status='POSTED' AND e.voucher_type IN ('RECEIPT','SALES') AND g.code IN ('1110','1120') AND e.entry_date BETWEEN ${from} AND ${to}) received,
      (SELECT coalesce(sum(l.credit),0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.id = a.group_id
        WHERE l.company_id = ${companyId} AND e.status='POSTED' AND e.voucher_type IN ('PAYMENT','PURCHASE') AND g.code IN ('1110','1120') AND e.entry_date BETWEEN ${from} AND ${to}) paid,
      (SELECT coalesce(sum(l.credit),0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id
        WHERE l.company_id = ${companyId} AND e.status='POSTED' AND e.voucher_type IN ('RECEIPT','SALES') AND a.system_key = 'DEBTORS_CONTROL' AND e.entry_date BETWEEN ${from} AND ${to}) collected,
      (SELECT coalesce(sum(l.debit - l.credit),0) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.id = a.group_id
        WHERE l.company_id = ${companyId} AND g.code IN ('5200','5300') AND a.system_key IS DISTINCT FROM 'ROUND_OFF' AND e.entry_date BETWEEN ${from} AND ${to}) expenses`);
  const x = r.rows[0];
  return { sales: D(x.sales), bills: x.bills, received: D(x.received), paid: D(x.paid), collected: D(x.collected), expenses: D(x.expenses) };
}

async function bankStatus(db: DB, companyId: string, today: string) {
  const r = await db.execute<{ last: string | null; open: number }>(sql`
    SELECT (SELECT max(to_date) FROM bank_statements WHERE company_id = ${companyId}) last,
      (SELECT count(*)::int FROM bank_statement_lines WHERE company_id = ${companyId} AND status = 'UNMATCHED') open`);
  const last = r.rows[0].last;
  return { last, open: r.rows[0].open, daysSince: last ? Math.round((Date.parse(today) - Date.parse(last)) / 86400000) : null };
}

export async function dailyBrief(db: DB, companyId: string, today = todayIST()) {
  const y = shift(today, -1);
  const [money, yday, cust, sup, stock, odd, bank] = await Promise.all([moneyPosition(db, companyId, today), flows(db, companyId, y, y),
    ageing(db, companyId, "CUSTOMER", today), ageing(db, companyId, "SUPPLIER", today), stockInsights(db, companyId, today), findings(db, companyId, today), bankStatus(db, companyId, today)]);
  const call = cust.parties.filter((p) => p.overdue.gt(0) || p.oldBalance.gt(0)).slice(0, 5);
  const pay = sup.parties.filter((p) => p.overdue.gt(0) || p.dueSoon.gt(0)).slice(0, 5);
  const reorder = stock.items.filter((i) => i.health === "OUT" || i.health === "LOW").sort((a, b) => (a.health === "OUT" ? 0 : 1) - (b.health === "OUT" ? 0 : 1)).slice(0, 5);
  const text = [
    `Daily brief — ${fmtDate(today)}`,
    `Cash & bank: ${formatINRShort(money.total)}`,
    `Yesterday: sales ${formatINRShort(yday.sales)} (${yday.bills} bills), money in ${formatINRShort(yday.received)}, money out ${formatINRShort(yday.paid)}`,
    call.length ? `Call today: ${call.map((p) => `${p.name} ${formatINRShort(p.overdue.plus(p.oldBalance))}`).join(", ")}` : "No overdue customers.",
    pay.length ? `Suppliers due: ${pay.map((p) => `${p.name} ${formatINRShort(p.overdue.plus(p.dueSoon))}`).join(", ")}` : null,
    reorder.length ? `Reorder: ${reorder.map((i) => i.name).join(", ")}` : null,
    odd.open.length ? `${odd.open.length} unusual item(s) to check.` : null,
  ].filter(Boolean).join("\n");
  return { today, yesterday: y, money, yday, call, pay, reorder, odd: odd.open, bank, overdueTotal: cust.overdue, text };
}

export async function weeklyReview(db: DB, companyId: string, today = todayIST()) {
  const to = today, from = shift(today, -6), pto = shift(from, -1), pfrom = shift(pto, -6);
  const [now, prev, pNow, pPrev, custNow, custThen, byCust, odd, bank] = await Promise.all([
    flows(db, companyId, from, to), flows(db, companyId, pfrom, pto), profitability(db, companyId, from, to, "product"), profitability(db, companyId, pfrom, pto, "product"),
    ageing(db, companyId, "CUSTOMER", to), ageing(db, companyId, "CUSTOMER", pto), profitability(db, companyId, from, to, "customer"), findings(db, companyId, today), bankStatus(db, companyId, today)]);
  const change = (a: Decimal, b: Decimal) => (b.isZero() ? null : a.minus(b).div(b.abs()).mul(100));
  const margin = (p: { totSales: Decimal; totProfit: Decimal }) => (p.totSales.isZero() ? null : p.totProfit.div(p.totSales).mul(100));
  const rows = [
    { label: "Sales (incl. GST)", now: now.sales, prev: prev.sales, good: "up" as const },
    { label: "Profit on goods", now: pNow.totProfit, prev: pPrev.totProfit, good: "up" as const },
    { label: "Collected from customers", now: now.collected, prev: prev.collected, good: "up" as const },
    { label: "Running costs", now: now.expenses, prev: prev.expenses, good: "down" as const },
    { label: "Customers owe you (end of week)", now: custNow.total, prev: custThen.total, good: "down" as const },
    { label: "…of which overdue", now: custNow.overdue, prev: custThen.overdue, good: "down" as const },
  ].map((r) => ({ ...r, pct: change(r.now, r.prev) }));
  const notes: string[] = [];
  const mN = margin(pNow), mP = margin(pPrev);
  if (mN && mP && mN.lt(mP.minus(1))) notes.push(`Margin fell from ${mP.toFixed(1)}% to ${mN.toFixed(1)}% — check the lowest-margin products below.`);
  if (now.collected.lt(now.sales.mul(0.5)) && now.sales.gt(0)) notes.push(`You collected ${formatINRShort(now.collected)} against sales of ${formatINRShort(now.sales)} — more is going on credit than coming back.`);
  if (custNow.overdue.gt(custThen.overdue)) notes.push(`Overdue money grew by ${formatINRShort(custNow.overdue.minus(custThen.overdue))} this week.`);
  if (bank.daysSince == null) notes.push("No bank statement uploaded yet — upload one to check your bank entries.");
  else if (bank.daysSince > 30) notes.push(`Last bank statement ends ${fmtDate(bank.last!)} — upload a newer one.`);
  const text = [`Weekly review — ${fmtDate(from)} to ${fmtDate(to)}`, ...rows.map((r) => `${r.label}: ${formatINRShort(r.now)}${r.pct ? ` (${r.pct.gte(0) ? "+" : ""}${r.pct.toFixed(0)}%)` : ""}`), ...notes].join("\n");
  return { from, to, pfrom, pto, rows, notes, marginNow: mN, marginPrev: mP,
    topCustomers: [...byCust.rows].sort((a, b) => b.sales.comparedTo(a.sales)).slice(0, 5), topProducts: pNow.rows.slice(0, 5),
    weakProducts: pNow.rows.filter((r) => r.flag && /Losing|low margin/i.test(r.flag)).slice(0, 5), odd: odd.open, bank, text };
}
