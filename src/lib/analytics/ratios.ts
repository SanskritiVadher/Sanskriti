/**
 * Ratio engine. Every ratio is computed from the ledger-based statements and documents, and carries its
 * formula, numerator, denominator, period, source accounts, benchmark (with where the benchmark came from),
 * a status with the reason, and plain-language meaning. No ratio is produced from a zero denominator or
 * from too little data.
 */
import { sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB } from "@/db";
import { D, formatINR } from "@/lib/money";
import { balanceSheet, profitAndLoss, previousPeriod } from "@/lib/accounting/statements";

export type Status = "HEALTHY" | "WATCH" | "CAUTION" | "DANGER" | "CRITICAL";
export type BenchSource = "YOUR_TARGET" | "YOUR_HISTORY" | "GENERAL_REFERENCE" | "YOUR_CREDIT_TERMS";
export type Ratio = {
  key: string; group: "Liquidity" | "Profitability" | "Efficiency" | "Working capital" | "Solvency" | "Growth & concentration";
  name: string; ownerName: string; unit: "x" | "%" | "days";
  value: Decimal | null; insufficient?: string;
  formula: string; numerator: { label: string; value: Decimal } | null; denominator: { label: string; value: Decimal } | null;
  sources: string[]; higherIsBetter: boolean | null;
  usual: Decimal | null; previous: Decimal | null; benchmark: { value: Decimal; source: BenchSource; note: string } | null;
  status: Status | null; statusReason: string; meaning: string; why: string | null; watch: string | null;
};

const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
const avg = (a: Decimal, b: Decimal) => a.plus(b).div(2);
const dayBefore = (d: string) => new Date(Date.parse(d + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);

/** Everything the ratios need for one period, from statements and documents. */
export async function facts(db: DB, companyId: string, from: string, to: string) {
  const [pl, open, close] = await Promise.all([profitAndLoss(db, companyId, from, to), balanceSheet(db, companyId, dayBefore(from)), balanceSheet(db, companyId, to)]);
  const bal = (b: typeof close) => {
    const pick = (pred: (x: (typeof close.current)[number]) => boolean) => b.current.filter(pred).reduce((s, x) => s.plus(x.amount), D(0));
    return {
      cash: pick((x) => ["1110", "1120"].includes(x.group_code)), debtors: pick((x) => x.system_key === "DEBTORS_CONTROL"),
      stock: pick((x) => x.system_key === "INVENTORY"), currentAssets: b.currentAssets, currentLiab: b.currentLiabilities,
      creditors: b.currentLiab.filter((x) => x.system_key === "CREDITORS_CONTROL").reduce((s, x) => s.plus(x.amount), D(0)),
      loans: b.loansTotal, assets: b.assets, liabilities: b.liabilities, stake: b.ownersStake,
    };
  };
  const doc = await db.execute<{ sales_gross: string; purch_gross: string }>(sql`
    SELECT
      (SELECT coalesce(sum(total),0) FROM sales_invoices WHERE company_id = ${companyId} AND status='ACTIVE' AND invoice_date BETWEEN ${from} AND ${to})
      - (SELECT coalesce(sum(total),0) FROM gst_notes WHERE company_id = ${companyId} AND kind='CREDIT_NOTE' AND note_date BETWEEN ${from} AND ${to}) AS sales_gross,
      (SELECT coalesce(sum(total),0) FROM purchase_bills WHERE company_id = ${companyId} AND status='ACTIVE' AND bill_date BETWEEN ${from} AND ${to})
      - (SELECT coalesce(sum(total),0) FROM gst_notes WHERE company_id = ${companyId} AND kind='DEBIT_NOTE' AND note_date BETWEEN ${from} AND ${to}) AS purch_gross`);
  const interest = pl.expenses.filter((e) => e.system_key === "INTEREST_EXPENSE").reduce((s, e) => s.plus(e.amount), D(0));
  const conc = await db.execute<{ kind: string; top3: string; total: string; n: number }>(sql`
    WITH c AS (SELECT party_id, sum(taxable) v FROM sales_invoices WHERE company_id = ${companyId} AND status='ACTIVE' AND invoice_date BETWEEN ${from} AND ${to} GROUP BY party_id),
         s AS (SELECT party_id, sum(taxable) v FROM purchase_bills WHERE company_id = ${companyId} AND status='ACTIVE' AND bill_date BETWEEN ${from} AND ${to} GROUP BY party_id)
    SELECT 'customer' kind, coalesce((SELECT sum(v) FROM (SELECT v FROM c ORDER BY v DESC LIMIT 3) t),0) top3, coalesce((SELECT sum(v) FROM c),0) total, (SELECT count(*)::int FROM c) n
    UNION ALL
    SELECT 'supplier', coalesce((SELECT sum(v) FROM (SELECT v FROM s ORDER BY v DESC LIMIT 3) t),0), coalesce((SELECT sum(v) FROM s),0), (SELECT count(*)::int FROM s)`);
  const act = await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM journal_entries WHERE company_id = ${companyId} AND entry_date BETWEEN ${from} AND ${to}
    AND source_type NOT IN ('opening','opening_party','opening_stock')`);
  const concOf = (k: string) => { const r = conc.rows.find((x) => x.kind === k)!; return { top3: D(r.top3), total: D(r.total), n: r.n }; };
  return { from, to, days: days(from, to), pl, open: bal(open), close: bal(close), salesGross: D(doc.rows[0].sales_gross), purchGross: D(doc.rows[0].purch_gross),
    interest, conc: { customer: concOf("customer"), supplier: concOf("supplier") }, activity: act.rows[0].n };
}
export type Facts = Awaited<ReturnType<typeof facts>>;

type Calc = { n: [string, Decimal]; d: [string, Decimal]; mult?: Decimal } | { value: Decimal | null; why?: string };
type Def = {
  key: string; group: Ratio["group"]; name: string; ownerName: string; unit: Ratio["unit"]; higherIsBetter: boolean | null;
  formula: string; sources: string[]; ref?: { value: number; note: string };
  calc: (f: Facts) => Calc; meaning: (v: Decimal) => string;
};
const ann = (f: Facts) => D(365).div(f.days);
const round = (v: Decimal, u: Ratio["unit"]) => (u === "days" ? v.toDecimalPlaces(0) : v.toDecimalPlaces(u === "%" ? 1 : 2));
export const fmtV = (v: Decimal, u: Ratio["unit"]) => (u === "%" ? `${v.toFixed(1)}%` : u === "days" ? `${v.toFixed(0)} days` : v.toFixed(2));

export const DEFS: Def[] = [
  { key: "current", group: "Liquidity", name: "Current ratio", ownerName: "Short-term money position", unit: "x", higherIsBetter: true, ref: { value: 1.2, note: "Many trading businesses aim for about 1.2 or more" },
    formula: "Current assets ÷ Current liabilities", sources: ["Cash, bank, customers, stock, GST credit", "Suppliers, GST payable, other dues"],
    calc: (f) => ({ n: ["Current assets", f.close.currentAssets], d: ["Current liabilities", f.close.currentLiab] }),
    meaning: (v) => `For every ₹1 you have to pay soon, the business has ₹${v.toFixed(2)} in cash, stock and money owed to it.` },
  { key: "quick", group: "Liquidity", name: "Quick ratio", ownerName: "Money position without selling stock", unit: "x", higherIsBetter: true, ref: { value: 0.8, note: "General reference: 0.8 or more; stock-heavy traders often run lower" },
    formula: "(Current assets − Stock) ÷ Current liabilities", sources: ["Cash, bank, customers, GST credit", "Current liabilities"],
    calc: (f) => ({ n: ["Current assets without stock", f.close.currentAssets.minus(f.close.stock)], d: ["Current liabilities", f.close.currentLiab] }),
    meaning: (v) => `Without selling any stock, you have ₹${v.toFixed(2)} for every ₹1 due soon.` },
  { key: "cash", group: "Liquidity", name: "Cash ratio", ownerName: "Cash cover", unit: "x", higherIsBetter: true,
    formula: "Cash & bank ÷ Current liabilities", sources: ["Cash, bank", "Current liabilities"],
    calc: (f) => ({ n: ["Cash & bank", f.close.cash], d: ["Current liabilities", f.close.currentLiab] }),
    meaning: (v) => `Cash in hand and bank covers ${v.mul(100).toFixed(0)}% of what's due soon.` },
  { key: "gross_margin", group: "Profitability", name: "Gross margin", ownerName: "Profit on goods", unit: "%", higherIsBetter: true,
    formula: "Gross profit ÷ Net sales × 100", sources: ["Sales, returns, cost of goods sold"],
    calc: (f) => ({ n: ["Gross profit", f.pl.grossProfit], d: ["Net sales", f.pl.netSales], mult: D(100) }),
    meaning: (v) => `On every ₹100 of goods sold, ₹${v.toFixed(1)} is left after the cost of those goods.` },
  { key: "net_margin", group: "Profitability", name: "Net margin", ownerName: "Profit after all costs", unit: "%", higherIsBetter: true,
    formula: "Net profit ÷ Net sales × 100", sources: ["All income and expense accounts"],
    calc: (f) => ({ n: ["Net profit", f.pl.netProfit], d: ["Net sales", f.pl.netSales], mult: D(100) }),
    meaning: (v) => `You keep ₹${v.toFixed(1)} of every ₹100 of sales as profit after all costs.` },
  { key: "roa", group: "Profitability", name: "Return on assets (yearly)", ownerName: "Profit from what the business owns", unit: "%", higherIsBetter: true,
    formula: "Net profit (annualised) ÷ Average total assets × 100", sources: ["Net profit", "Total assets, start and end"],
    calc: (f) => ({ n: ["Net profit, annualised", f.pl.netProfit.mul(ann(f))], d: ["Average total assets", avg(f.open.assets, f.close.assets)], mult: D(100) }),
    meaning: (v) => `Everything the business owns earns about ${v.toFixed(1)}% a year.` },
  { key: "roe", group: "Profitability", name: "Return on equity (yearly)", ownerName: "Return on your money in the business", unit: "%", higherIsBetter: true,
    formula: "Net profit (annualised) ÷ Average owner's stake × 100", sources: ["Net profit", "Capital + retained profit"],
    calc: (f) => { const e = avg(f.open.stake, f.close.stake); return e.lte(0) ? { value: null, why: "Owner's stake is zero or negative, so this can't be worked out meaningfully." } : { n: ["Net profit, annualised", f.pl.netProfit.mul(ann(f))], d: ["Average owner's stake", e], mult: D(100) }; },
    meaning: (v) => `Your money in the business earns about ${v.toFixed(1)}% a year. Compare with what a bank FD pays.` },
  { key: "roce", group: "Profitability", name: "Return on capital employed (yearly)", ownerName: "Return on all long-term money used", unit: "%", higherIsBetter: true,
    formula: "Profit before interest (annualised) ÷ (Total assets − Current liabilities) × 100", sources: ["Net profit + interest", "Total assets, current liabilities"],
    calc: (f) => ({ n: ["Profit before interest, annualised", f.pl.netProfit.plus(f.interest).mul(ann(f))], d: ["Capital employed", f.close.assets.minus(f.close.currentLiab)], mult: D(100) }),
    meaning: (v) => `All the long-term money in the business (yours and loans) earns ${v.toFixed(1)}% a year before interest.` },
  { key: "inv_turnover", group: "Efficiency", name: "Inventory turnover (yearly)", ownerName: "How often stock sells out in a year", unit: "x", higherIsBetter: true,
    formula: "Cost of goods sold (annualised) ÷ Average stock", sources: ["Cost of goods sold", "Stock, start and end"],
    calc: (f) => ({ n: ["Cost of goods sold, annualised", f.pl.cogsTotal.mul(ann(f))], d: ["Average stock", avg(f.open.stock, f.close.stock)] }),
    meaning: (v) => `Your stock is sold and replaced about ${v.toFixed(1)} times a year.` },
  { key: "rec_turnover", group: "Efficiency", name: "Receivables turnover (yearly)", ownerName: "How often customer dues are collected in a year", unit: "x", higherIsBetter: true,
    formula: "Sales incl. GST (annualised) ÷ Average customer dues", sources: ["Invoices − credit notes", "Customers, start and end"],
    calc: (f) => ({ n: ["Sales incl. GST, annualised", f.salesGross.mul(ann(f))], d: ["Average customer dues", avg(f.open.debtors, f.close.debtors)] }),
    meaning: (v) => `Customer dues are collected and replaced about ${v.toFixed(1)} times a year.` },
  { key: "pay_turnover", group: "Efficiency", name: "Payables turnover (yearly)", ownerName: "How often you pay suppliers off in a year", unit: "x", higherIsBetter: null,
    formula: "Purchases incl. GST (annualised) ÷ Average supplier dues", sources: ["Bills − debit notes", "Suppliers, start and end"],
    calc: (f) => ({ n: ["Purchases incl. GST, annualised", f.purchGross.mul(ann(f))], d: ["Average supplier dues", avg(f.open.creditors, f.close.creditors)] }),
    meaning: (v) => `You clear what you owe suppliers about ${v.toFixed(1)} times a year.` },
  { key: "asset_turnover", group: "Efficiency", name: "Asset turnover (yearly)", ownerName: "Sales made from what the business owns", unit: "x", higherIsBetter: true,
    formula: "Net sales (annualised) ÷ Average total assets", sources: ["Net sales", "Total assets"],
    calc: (f) => ({ n: ["Net sales, annualised", f.pl.netSales.mul(ann(f))], d: ["Average total assets", avg(f.open.assets, f.close.assets)] }),
    meaning: (v) => `Each ₹1 the business owns brings in ₹${v.toFixed(2)} of sales a year.` },
  { key: "dso", group: "Working capital", name: "Days sales outstanding (DSO)", ownerName: "Days customers take to pay", unit: "days", higherIsBetter: false,
    formula: "Average customer dues ÷ (Sales incl. GST ÷ days in period)", sources: ["Customers", "Invoices − credit notes"],
    calc: (f) => ({ n: ["Average customer dues", avg(f.open.debtors, f.close.debtors)], d: ["Sales incl. GST per day", f.salesGross.div(f.days)] }),
    meaning: (v) => `On average, customers take about ${v.toFixed(0)} days to pay you.` },
  { key: "dio", group: "Working capital", name: "Days inventory outstanding (DIO)", ownerName: "Days stock sits before it sells", unit: "days", higherIsBetter: false,
    formula: "Average stock ÷ (Cost of goods sold ÷ days in period)", sources: ["Stock", "Cost of goods sold"],
    calc: (f) => ({ n: ["Average stock", avg(f.open.stock, f.close.stock)], d: ["Cost of goods sold per day", f.pl.cogsTotal.div(f.days)] }),
    meaning: (v) => `Stock sits for about ${v.toFixed(0)} days before it is sold.` },
  { key: "dpo", group: "Working capital", name: "Days payables outstanding (DPO)", ownerName: "Days you take to pay suppliers", unit: "days", higherIsBetter: null,
    formula: "Average supplier dues ÷ (Purchases incl. GST ÷ days in period)", sources: ["Suppliers", "Bills − debit notes"],
    calc: (f) => ({ n: ["Average supplier dues", avg(f.open.creditors, f.close.creditors)], d: ["Purchases incl. GST per day", f.purchGross.div(f.days)] }),
    meaning: (v) => `You take about ${v.toFixed(0)} days to pay suppliers.` },
  { key: "ccc", group: "Working capital", name: "Cash conversion cycle", ownerName: "Days your money is locked up", unit: "days", higherIsBetter: false,
    formula: "DSO + DIO − DPO", sources: ["DSO, DIO, DPO"], calc: () => ({ value: null }),
    meaning: (v) => v.lte(0) ? "Suppliers are effectively funding your stock and credit: money comes back before you pay." : `From paying for stock to getting paid by the customer, your money is locked up for about ${v.toFixed(0)} days.` },
  { key: "de", group: "Solvency", name: "Debt-to-equity", ownerName: "Loans compared with your own money", unit: "x", higherIsBetter: false, ref: { value: 1, note: "General reference: loans up to about equal to your own money" },
    formula: "Loans ÷ Owner's stake", sources: ["Loans", "Capital + retained profit"],
    calc: (f) => f.close.stake.lte(0) ? { value: null, why: "Owner's stake is zero or negative." } : ({ n: ["Loans", f.close.loans], d: ["Owner's stake", f.close.stake] }),
    meaning: (v) => `For every ₹1 of your own money, the business has borrowed ₹${v.toFixed(2)}.` },
  { key: "debt_ratio", group: "Solvency", name: "Debt ratio", ownerName: "Share of the business funded by others", unit: "%", higherIsBetter: false, ref: { value: 60, note: "General reference: under about 60%" },
    formula: "Total liabilities ÷ Total assets × 100", sources: ["All liabilities", "All assets"],
    calc: (f) => ({ n: ["Total liabilities", f.close.liabilities], d: ["Total assets", f.close.assets], mult: D(100) }),
    meaning: (v) => `${v.toFixed(0)}% of what the business owns is paid for with suppliers' credit, loans and other dues.` },
  { key: "icr", group: "Solvency", name: "Interest coverage", ownerName: "How easily profit pays loan interest", unit: "x", higherIsBetter: true, ref: { value: 3, note: "General reference: 3 times or more" },
    formula: "Profit before interest ÷ Interest", sources: ["Net profit + interest", "Interest on loan"],
    calc: (f) => f.interest.isZero() ? { value: null, why: "No loan interest recorded in this period." } : ({ n: ["Profit before interest", f.pl.netProfit.plus(f.interest)], d: ["Interest", f.interest] }),
    meaning: (v) => `Profit before interest is ${v.toFixed(1)} times the interest you pay.` },
  { key: "cust_conc", group: "Growth & concentration", name: "Customer concentration (top 3)", ownerName: "Depending on a few customers", unit: "%", higherIsBetter: false, ref: { value: 50, note: "General reference: under about 50%" },
    formula: "Sales to top 3 customers ÷ All sales × 100", sources: ["Invoices by customer"],
    calc: (f) => f.conc.customer.n < 4 ? { value: null, why: "Fewer than 4 customers billed in this period." } : ({ n: ["Top 3 customers' sales", f.conc.customer.top3], d: ["All sales", f.conc.customer.total], mult: D(100) }),
    meaning: (v) => `Your top 3 customers make up ${v.toFixed(0)}% of sales.` },
  { key: "sup_conc", group: "Growth & concentration", name: "Supplier concentration (top 3)", ownerName: "Depending on a few suppliers", unit: "%", higherIsBetter: null,
    formula: "Purchases from top 3 suppliers ÷ All purchases × 100", sources: ["Bills by supplier"],
    calc: (f) => f.conc.supplier.n === 0 ? { value: null, why: "No purchases in this period." } : ({ n: ["Top 3 suppliers' purchases", f.conc.supplier.top3], d: ["All purchases", f.conc.supplier.total], mult: D(100) }),
    meaning: (v) => `Your top 3 suppliers provide ${v.toFixed(0)}% of what you buy. For an authorised dealer, a high share is normal.` },
];

function raw(def: Def, f: Facts): { value: Decimal | null; n: [string, Decimal] | null; d: [string, Decimal] | null; why?: string } {
  const r = def.calc(f);
  if ("value" in r) return { value: r.value, n: null, d: null, why: r.why };
  if (r.d[1].lte(0)) return { value: null, n: r.n, d: r.d, why: `${r.d[0]} is zero, so this can't be worked out.` };
  return { value: round(r.n[1].div(r.d[1]).mul(r.mult ?? 1), def.unit), n: r.n, d: r.d };
}

/** Distance from the benchmark decides the band. The benchmark always has a named source. */
export function statusFor(v: Decimal, bench: Decimal, higher: boolean): Status {
  if (bench.lte(0)) return "HEALTHY";
  const ratio = higher ? v.div(bench) : bench.div(v.lte(0) ? D("0.0001") : v);
  if (ratio.gte(1)) return "HEALTHY";
  if (ratio.gte(0.85)) return "WATCH";
  if (ratio.gte(0.7)) return "CAUTION";
  if (ratio.gte(0.5)) return "DANGER";
  return "CRITICAL";
}

export async function ratioTargets(db: DB, companyId: string) {
  const r = await db.execute<{ value: Record<string, number> }>(sql`SELECT value FROM settings WHERE company_id = ${companyId} AND key = 'ratio_targets'`);
  return (r.rows[0]?.value ?? {}) as Record<string, number>;
}
export async function saveTargets(db: DB, companyId: string, targets: Record<string, number>) {
  await db.insert(schema.settings).values({ companyId, key: "ratio_targets", value: targets })
    .onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value: targets } });
}

/** Weighted average credit days given to customers / taken from suppliers — the natural benchmark for DSO / DPO. */
async function creditTerms(db: DB, companyId: string, from: string, to: string) {
  const r = await db.execute<{ kind: string; d: string | null }>(sql`
    SELECT 'c' kind, sum(i.total * coalesce(p.credit_days,0)) / nullif(sum(i.total),0) d FROM sales_invoices i JOIN parties p ON p.id = i.party_id
      WHERE i.company_id = ${companyId} AND i.status='ACTIVE' AND i.invoice_date BETWEEN ${from} AND ${to}
    UNION ALL
    SELECT 's', sum(b.total * coalesce(p.credit_days,0)) / nullif(sum(b.total),0) FROM purchase_bills b JOIN parties p ON p.id = b.party_id
      WHERE b.company_id = ${companyId} AND b.status='ACTIVE' AND b.bill_date BETWEEN ${from} AND ${to}`);
  const g = (k: string) => { const v = r.rows.find((x) => x.kind === k)?.d; return v == null ? null : D(v).toDecimalPlaces(0); };
  return { customer: g("c"), supplier: g("s") };
}

function allValues(f: Facts) {
  const m = new Map<string, Decimal | null>();
  for (const d of DEFS) m.set(d.key, raw(d, f).value);
  const dso = m.get("dso"), dio = m.get("dio"), dpo = m.get("dpo");
  m.set("ccc", dso != null && dio != null && dpo != null ? dso.plus(dio).minus(dpo) : null);
  return m;
}
const MIN_ACTIVITY = 5, MIN_DAYS = 14;

export async function computeRatios(db: DB, companyId: string, from: string, to: string) {
  const periods = [{ from, to }];
  for (let i = 0; i < 3; i++) periods.push(previousPeriod(periods[i].from, periods[i].to));
  const all = await Promise.all(periods.map((p) => facts(db, companyId, p.from, p.to)));
  const [f, prev] = all;
  const [targets, terms] = await Promise.all([ratioTargets(db, companyId), creditTerms(db, companyId, from, to)]);
  const enough = f.activity >= MIN_ACTIVITY && f.days >= MIN_DAYS;
  const now = allValues(f);
  const hist = all.slice(1).map((x) => (x.activity >= MIN_ACTIVITY ? allValues(x) : null));

  const ratios = DEFS.map((def): Ratio => {
    const rv = def.key === "ccc" ? null : raw(def, f);
    let value = now.get(def.key) ?? null;
    let insufficient = !enough ? `Not enough activity in this period to work this out reliably (needs at least ${MIN_ACTIVITY} transactions over ${MIN_DAYS} days).`
      : def.key === "ccc" && value == null ? "Needs customer days, stock days and supplier days; one of them can't be worked out." : rv?.why;
    if (insufficient) value = null; else insufficient = undefined;
    const h = hist.map((x) => x?.get(def.key) ?? null).filter((x): x is Decimal => x != null);
    const usual = h.length >= 2 ? [...h].sort((a, b) => a.comparedTo(b))[Math.floor(h.length / 2)] : null;
    const previous = hist[0]?.get(def.key) ?? null;

    let benchmark: Ratio["benchmark"] = null;
    if (targets[def.key] != null) benchmark = { value: D(targets[def.key]), source: "YOUR_TARGET", note: "Target you set" };
    else if (def.key === "dso" && terms.customer?.gt(0)) benchmark = { value: terms.customer, source: "YOUR_CREDIT_TERMS", note: `Credit days you give customers (weighted by sales): ${terms.customer}` };
    else if (def.key === "dpo" && terms.supplier?.gt(0)) benchmark = { value: terms.supplier, source: "YOUR_CREDIT_TERMS", note: `Credit days suppliers give you: ${terms.supplier}` };
    else if (usual && def.higherIsBetter != null) benchmark = { value: usual, source: "YOUR_HISTORY", note: `Your usual level (middle of the last ${h.length} periods)` };
    else if (def.ref) benchmark = { value: D(def.ref.value), source: "GENERAL_REFERENCE", note: `${def.ref.note}. A general guide, not a rule; it varies by business.` };

    // DPO against supplier terms: paying much later than terms is also a risk, so treat it as "lower is better" there.
    const higher = def.key === "dpo" && benchmark?.source === "YOUR_CREDIT_TERMS" ? false : def.higherIsBetter;
    let status: Status | null = null, statusReason = "";
    if (value != null && benchmark && higher != null) {
      status = statusFor(value, benchmark.value, higher);
      const better = higher ? value.gt(benchmark.value) : value.lt(benchmark.value);
      const what = { YOUR_TARGET: "your target", YOUR_HISTORY: "your usual", YOUR_CREDIT_TERMS: "your credit terms", GENERAL_REFERENCE: "the general reference" }[benchmark.source];
      statusReason = `${fmtV(value, def.unit)} is ${value.eq(benchmark.value) ? "equal to" : better ? "better than" : "worse than"} ${what} of ${fmtV(benchmark.value, def.unit)}.`;
    } else if (value != null) statusReason = def.higherIsBetter == null ? "Neither high nor low is automatically good here; watch the trend." : "No benchmark yet. Your own history will be used once there are more periods.";

    return { key: def.key, group: def.group, name: def.name, ownerName: def.ownerName, unit: def.unit, value, insufficient, formula: def.formula,
      numerator: rv?.n ? { label: rv.n[0], value: rv.n[1] } : null, denominator: rv?.d ? { label: rv.d[0], value: rv.d[1] } : null,
      sources: def.sources, higherIsBetter: higher, usual, previous, benchmark, status, statusReason,
      meaning: value != null ? def.meaning(value) : "", why: value != null && previous != null ? explain(def.key, f, prev) : null,
      watch: value != null ? watchFor(def.key, status, f) : null };
  });
  return { ratios, facts: f, previousPeriod: periods[1] };
}

/** Which underlying figures moved vs the previous period — facts only, largest first. */
function explain(key: string, f: Facts, p: Facts): string | null {
  const moves = (items: [string, Decimal, Decimal][]) => items.map(([l, a, b]) => ({ l, d: a.minus(b) })).filter((x) => !x.d.isZero())
    .sort((a, b) => b.d.abs().comparedTo(a.d.abs())).slice(0, 2).map((x) => `${x.l} ${x.d.gt(0) ? "went up" : "went down"} by ${formatINR(x.d.abs())}`).join("; ");
  let s = "";
  if (["current", "quick", "cash"].includes(key)) s = moves([["Money with customers", f.close.debtors, p.close.debtors], ["Stock", f.close.stock, p.close.stock], ["Cash & bank", f.close.cash, p.close.cash], ["Owed to suppliers", f.close.creditors, p.close.creditors]]);
  else if (["gross_margin", "net_margin", "roa", "roe", "roce"].includes(key)) s = moves([["Net sales", f.pl.netSales, p.pl.netSales], ["Cost of goods sold", f.pl.cogsTotal, p.pl.cogsTotal], ["Running costs", f.pl.expensesTotal, p.pl.expensesTotal]]);
  else if (["dso", "rec_turnover"].includes(key)) s = moves([["Money with customers", f.close.debtors, p.close.debtors], ["Sales incl. GST", f.salesGross, p.salesGross]]);
  else if (["dio", "inv_turnover"].includes(key)) s = moves([["Stock", f.close.stock, p.close.stock], ["Cost of goods sold", f.pl.cogsTotal, p.pl.cogsTotal]]);
  else if (["dpo", "pay_turnover"].includes(key)) s = moves([["Owed to suppliers", f.close.creditors, p.close.creditors], ["Purchases incl. GST", f.purchGross, p.purchGross]]);
  return s ? `Compared with the previous period: ${s}.` : null;
}
function watchFor(key: string, status: Status | null, f: Facts): string | null {
  if (!status || status === "HEALTHY") return null;
  const m: Record<string, string> = {
    current: `Watch overdue customer payments (${formatINR(f.close.debtors)} is with customers) and supplier payments coming up.`,
    quick: "Collect overdue dues before buying more stock.", cash: "Keep enough cash for supplier payments due this week.",
    gross_margin: "Check purchase price rises and discounts on the Profitability page.", net_margin: "See which running costs grew on the Profit page.",
    dso: "Use the 'Call these first' list on Customers.", dio: "Check slow-moving stock before reordering.", ccc: "Collect faster and avoid over-stocking.",
    dpo: "You're paying suppliers later than their credit terms; this can cost you schemes and goodwill.",
    de: "Avoid new loans until profit covers the current ones comfortably.", debt_ratio: "Pay down supplier dues or loans as cash allows.",
    icr: "Profit is thin compared with interest; avoid more borrowing.", cust_conc: "Losing one big customer would hurt; widen the customer base.",
    inv_turnover: "Stock is selling slowly; check slow movers.", rec_turnover: "Collections are slow; use the call list.",
    roa: "Assets aren't earning much; free up idle stock and dues.", roe: "Your money earns less than usual in the business.",
    roce: "Capital isn't earning much; check stock and dues tied up.", asset_turnover: "Sales are low for the stock and dues you carry.",
  };
  return m[key] ?? null;
}
