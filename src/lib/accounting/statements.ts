/**
 * Financial statements, computed only from journal lines.
 * - P&L for a date range (trading section → gross profit; then other income/expenses → net profit)
 * - Balance sheet at a date; owner's stake = capital + earlier years' profit + this year's profit (no closing entries needed)
 * - Cash flow: direct (owner) and indirect (accountant); both must equal the change in cash + bank.
 */
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import type { DB } from "@/db";
import { D } from "@/lib/money";
import { fyStart } from "@/lib/dates";

type Nature = "ASSET" | "LIABILITY" | "EQUITY" | "INCOME" | "EXPENSE";
type Row = { id: string; code: string; name: string; owner_label: string; nature: Nature; system_key: string | null; group_code: string; group_name: string; group_owner: string; dr: string; cr: string };

async function balances(db: DB, companyId: string, from: string | null, to: string) {
  const r = await db.execute<Row>(sql`
    SELECT a.id, a.code, a.name, a.owner_label, a.nature, a.system_key, g.code AS group_code, g.name AS group_name, g.owner_label AS group_owner,
      coalesce(sum(l.debit),0) AS dr, coalesce(sum(l.credit),0) AS cr
    FROM accounts a JOIN account_groups g ON g.id = a.group_id
    LEFT JOIN journal_lines l ON l.account_id = a.id AND l.entry_id IN (
      SELECT id FROM journal_entries WHERE company_id = ${companyId} AND entry_date <= ${to} ${from ? sql`AND entry_date >= ${from}` : sql``})
    WHERE a.company_id = ${companyId} GROUP BY a.id, g.id ORDER BY a.code`);
  return r.rows.map((x) => ({ ...x, amount: x.nature === "ASSET" || x.nature === "EXPENSE" ? D(x.dr).minus(x.cr) : D(x.cr).minus(x.dr) }));
}
export type Bal = Awaited<ReturnType<typeof balances>>[number];
const sum = (xs: { amount: Decimal }[]) => xs.reduce((s, x) => s.plus(x.amount), D(0));
const nz = <T extends { amount: Decimal }>(xs: T[]) => xs.filter((x) => !x.amount.isZero());

// ───── Profit & loss ─────
export async function profitAndLoss(db: DB, companyId: string, from: string, to: string) {
  const b = await balances(db, companyId, from, to);
  const sales = b.filter((x) => x.system_key === "SALES"), returns = b.filter((x) => x.system_key === "SALES_RETURNS");
  const netSales = sum(sales).plus(sum(returns)); // returns carry a negative (debit) balance on an income account
  const cogs = b.filter((x) => x.group_code === "5100"), direct = b.filter((x) => x.group_code === "5200");
  const grossProfit = netSales.minus(sum(cogs)).minus(sum(direct));
  const otherIncome = b.filter((x) => x.nature === "INCOME" && x.group_code !== "4100");
  const expenses = b.filter((x) => x.group_code === "5300");
  const netProfit = grossProfit.plus(sum(otherIncome)).minus(sum(expenses));
  // Cross-check: equals income − expense over the same lines.
  const check = sum(b.filter((x) => x.nature === "INCOME")).minus(sum(b.filter((x) => x.nature === "EXPENSE")));
  return { from, to, sales: sum(sales), returns: sum(returns).neg(), netSales, cogs: nz(cogs), cogsTotal: sum(cogs), direct: nz(direct), directTotal: sum(direct),
    grossProfit, grossMargin: netSales.isZero() ? null : grossProfit.div(netSales).mul(100),
    otherIncome: nz(otherIncome), otherIncomeTotal: sum(otherIncome), expenses: nz(expenses).sort((a, c) => c.amount.comparedTo(a.amount)), expensesTotal: sum(expenses),
    netProfit, netMargin: netSales.isZero() ? null : netProfit.div(netSales).mul(100), reconciles: check.eq(netProfit) };
}

/** Same length period immediately before, for comparison. */
export function previousPeriod(from: string, to: string) {
  const f = new Date(from + "T00:00:00Z"), t = new Date(to + "T00:00:00Z");
  const days = Math.round((+t - +f) / 86400000) + 1;
  const sameMonths = f.getUTCDate() === 1 && new Date(+t + 86400000).getUTCDate() === 1;
  if (sameMonths) {
    const months = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + t.getUTCMonth() - f.getUTCMonth() + 1;
    const pf = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - months, 1)), pt = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0));
    return { from: pf.toISOString().slice(0, 10), to: pt.toISOString().slice(0, 10) };
  }
  const pt = new Date(+f - 86400000), pf = new Date(+pt - (days - 1) * 86400000);
  return { from: pf.toISOString().slice(0, 10), to: pt.toISOString().slice(0, 10) };
}

/** Why profit changed — arithmetic only: volume effect, margin effect, other income, and each expense's change. */
export function explainChange(now: Awaited<ReturnType<typeof profitAndLoss>>, prev: Awaited<ReturnType<typeof profitAndLoss>>) {
  const change = now.netProfit.minus(prev.netProfit);
  const prevGm = prev.netSales.isZero() ? D(0) : prev.grossProfit.div(prev.netSales);
  const nowGm = now.netSales.isZero() ? D(0) : now.grossProfit.div(now.netSales);
  const volume = now.netSales.minus(prev.netSales).mul(prevGm);            // selling more/less at last period's margin
  const margin = now.netSales.mul(nowGm.minus(prevGm));                     // better/worse margin on this period's sales
  const other = now.otherIncomeTotal.minus(prev.otherIncomeTotal);
  const exp = new Map<string, { label: string; change: Decimal }>();
  for (const e of [...now.expenses, ...prev.expenses]) exp.set(e.id, { label: e.owner_label, change: D(0) });
  for (const e of now.expenses) exp.get(e.id)!.change = exp.get(e.id)!.change.minus(e.amount);
  for (const e of prev.expenses) exp.get(e.id)!.change = exp.get(e.id)!.change.plus(e.amount);
  const parts = [
    { label: now.netSales.gte(prev.netSales) ? "Sold more" : "Sold less", effect: volume.toDecimalPlaces(2) },
    { label: nowGm.gte(prevGm) ? "Better margin on what you sold" : "Lower margin on what you sold", effect: margin.toDecimalPlaces(2) },
    ...(other.isZero() ? [] : [{ label: "Other income", effect: other }]),
    ...[...exp.values()].filter((e) => !e.change.isZero()).map((e) => ({ label: e.change.gt(0) ? `Lower ${e.label.toLowerCase()}` : `Higher ${e.label.toLowerCase()}`, effect: e.change })),
  ].sort((a, b) => b.effect.abs().comparedTo(a.effect.abs()));
  // Rounding residue (paise) so parts add up exactly.
  const residue = change.minus(parts.reduce((s, p) => s.plus(p.effect), D(0)));
  if (!residue.isZero() && parts.length) parts[0].effect = parts[0].effect.plus(residue);
  return { change, parts, marginNow: nowGm.mul(100), marginPrev: prevGm.mul(100) };
}

// ───── Balance sheet ─────
export async function balanceSheet(db: DB, companyId: string, asOf: string) {
  const b = await balances(db, companyId, null, asOf);
  const fy = fyStart(asOf);
  const pnlBefore = await balances(db, companyId, null, new Date(Date.parse(fy + "T00:00:00Z") - 86400000).toISOString().slice(0, 10));
  const earlier = sum(pnlBefore.filter((x) => x.nature === "INCOME")).minus(sum(pnlBefore.filter((x) => x.nature === "EXPENSE")));
  const thisYear = sum(b.filter((x) => x.nature === "INCOME")).minus(sum(b.filter((x) => x.nature === "EXPENSE"))).minus(earlier);
  const current = nz(b.filter((x) => x.nature === "ASSET" && x.group_code.startsWith("11")));
  const fixed = nz(b.filter((x) => x.nature === "ASSET" && x.group_code === "1200"));
  const currentLiab = nz(b.filter((x) => x.nature === "LIABILITY" && x.group_code.startsWith("21")));
  const loans = nz(b.filter((x) => x.nature === "LIABILITY" && x.group_code === "2200"));
  const equity = nz(b.filter((x) => x.nature === "EQUITY"));
  const assets = sum(current).plus(sum(fixed));
  const liabilities = sum(currentLiab).plus(sum(loans));
  const ownersStake = sum(equity).plus(earlier).plus(thisYear);
  return { asOf, current, fixed, currentLiab, loans, equity, earlierProfit: earlier, profitThisYear: thisYear, fyStart: fy,
    currentAssets: sum(current), fixedAssets: sum(fixed), currentLiabilities: sum(currentLiab), loansTotal: sum(loans),
    assets, liabilities, ownersStake, balanced: assets.eq(liabilities.plus(ownersStake)) };
}

// ───── Cash flow ─────
const CASH_GROUPS = ["1110", "1120"];
type Cat = "customers" | "suppliers" | "expenses" | "gst" | "otherIncome" | "assets" | "owner" | "loans" | "other";
export const CASH_LABEL: Record<Cat, string> = { customers: "Received from customers", suppliers: "Paid to suppliers", expenses: "Running costs paid",
  gst: "GST paid to government", otherIncome: "Other income received", assets: "Bought / sold equipment & vehicles", owner: "Owner put in / took out", loans: "Loans taken / repaid", other: "Other" };
const catOf = (k: string | null, g: string, nature: Nature): Cat => {
  if (k === "DEBTORS_CONTROL" || k === "CUSTOMER_ADVANCES" || k === "SALES" || k === "SALES_RETURNS") return "customers";
  if (k === "CREDITORS_CONTROL" || k === "SUPPLIER_ADVANCES" || k === "INVENTORY") return "suppliers";
  if (k?.startsWith("INPUT_") || k?.startsWith("OUTPUT_")) return "gst";
  if (g === "1200") return "assets";
  if (nature === "EQUITY") return "owner";
  if (g === "2200") return "loans";
  if (nature === "EXPENSE" || k === "EXPENSES_PAYABLE") return "expenses";
  if (nature === "INCOME") return "otherIncome";
  return "other";
};

export async function cashFlow(db: DB, companyId: string, from: string, to: string) {
  // Opening/closing cash + bank.
  const cashAt = async (d: string) => {
    const r = await db.execute<{ v: string }>(sql`SELECT coalesce(sum(l.debit - l.credit),0) AS v FROM journal_lines l
      JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.id = a.group_id JOIN journal_entries e ON e.id = l.entry_id
      WHERE l.company_id = ${companyId} AND g.code IN ('1110','1120') AND e.entry_date <= ${d}`);
    return D(r.rows[0].v);
  };
  const dayBefore = new Date(Date.parse(from + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  const [opening, closing] = await Promise.all([cashAt(dayBefore), cashAt(to)]);

  // Direct: each entry's net cash movement, attributed to its non-cash lines in proportion.
  const lines = await db.execute<{ entry_id: string; system_key: string | null; group_code: string; nature: Nature; dr: string; cr: string }>(sql`
    SELECT l.entry_id, a.system_key, g.code AS group_code, a.nature, l.debit AS dr, l.credit AS cr
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.id = a.group_id JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.company_id = ${companyId} AND e.entry_date BETWEEN ${from} AND ${to}
      AND l.entry_id IN (SELECT l2.entry_id FROM journal_lines l2 JOIN accounts a2 ON a2.id = l2.account_id JOIN account_groups g2 ON g2.id = a2.group_id WHERE g2.code IN ('1110','1120'))`);
  const byEntry = new Map<string, typeof lines.rows>();
  for (const l of lines.rows) (byEntry.get(l.entry_id) ?? byEntry.set(l.entry_id, []).get(l.entry_id)!).push(l);
  const flows = new Map<Cat, Decimal>();
  let openingBooked = D(0);
  for (const ls of byEntry.values()) {
    const cash = ls.filter((l) => CASH_GROUPS.includes(l.group_code)).reduce((s, l) => s.plus(l.dr).minus(l.cr), D(0));
    if (cash.isZero()) continue; // cash ↔ bank transfers
    const others = ls.filter((l) => !CASH_GROUPS.includes(l.group_code));
    // Opening balances dated inside the range are shown as starting money, not as a "flow".
    if (others.some((o) => o.system_key === "OPENING_BALANCE_EQUITY") && others.every((o) => o.system_key === "OPENING_BALANCE_EQUITY" || o.nature !== "EXPENSE")) {
      openingBooked = openingBooked.plus(cash); continue;
    }
    const weights = others.map((o) => ({ cat: catOf(o.system_key, o.group_code, o.nature), w: D(o.dr).minus(o.cr).neg() })); // other side's opposite = cash direction
    const tot = weights.reduce((s, w) => s.plus(w.w), D(0));
    let left = cash;
    weights.forEach((w, i) => {
      const part = i === weights.length - 1 ? left : tot.isZero() ? D(0) : cash.mul(w.w).div(tot).toDecimalPlaces(2);
      left = left.minus(part);
      flows.set(w.cat, (flows.get(w.cat) ?? D(0)).plus(part));
    });
  }
  const direct = (Object.keys(CASH_LABEL) as Cat[]).map((c) => ({ cat: c, label: CASH_LABEL[c], amount: flows.get(c) ?? D(0) })).filter((x) => !x.amount.isZero());
  const directNet = direct.reduce((s, x) => s.plus(x.amount), D(0)).plus(openingBooked);

  // Indirect: profit + non-cash items + working-capital changes + investing + financing.
  const pl = await profitAndLoss(db, companyId, from, to);
  const [a, z] = await Promise.all([balances(db, companyId, null, dayBefore), balances(db, companyId, null, to)]);
  const delta = (pred: (x: Bal) => boolean) => sum(z.filter(pred)).minus(sum(a.filter(pred)));
  const dep = sum((await balances(db, companyId, from, to)).filter((x) => x.system_key === "DEPRECIATION"));
  const wc = [
    { label: "Money stuck with customers went up (−) / down (+)", amount: delta((x) => x.system_key === "DEBTORS_CONTROL").neg() },
    { label: "Stock went up (−) / down (+)", amount: delta((x) => x.system_key === "INVENTORY").neg() },
    { label: "GST credit and other advances", amount: delta((x) => x.nature === "ASSET" && ["1150", "1160"].includes(x.group_code)).neg() },
    { label: "Owed to suppliers went up (+) / down (−)", amount: delta((x) => x.system_key === "CREDITORS_CONTROL") },
    { label: "GST payable and other dues", amount: delta((x) => x.nature === "LIABILITY" && ["2120", "2130"].includes(x.group_code)) },
  ].filter((x) => !x.amount.isZero());
  const operating = pl.netProfit.plus(dep).plus(wc.reduce((s, x) => s.plus(x.amount), D(0)));
  const investing = delta((x) => x.group_code === "1200").plus(dep).neg();
  const financing = delta((x) => x.nature === "EQUITY").plus(delta((x) => x.group_code === "2200"));
  const indirectNet = operating.plus(investing).plus(financing);
  return { from, to, opening, closing, change: closing.minus(opening), direct, openingBooked, directNet,
    indirect: { profit: pl.netProfit, depreciation: dep, wc, operating, investing, financing, net: indirectNet },
    reconciles: directNet.eq(closing.minus(opening)) && indirectNet.eq(closing.minus(opening)) };
}
