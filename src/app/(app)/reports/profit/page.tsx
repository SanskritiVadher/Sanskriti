import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { profitAndLoss, previousPeriod, explainChange, type Bal } from "@/lib/accounting/statements";
import { formatINR, formatINRShort } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Card, PageHeader, Status } from "@/components/ui";
import { RangePicker, resolveRange } from "@/components/range-picker";
import type Decimal from "decimal.js";

const pct = (a: Decimal, b: Decimal) => (b.isZero() ? null : a.minus(b).div(b.abs()).mul(100));
export default async function Profit({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const r = resolveRange(await searchParams);
  const pp = previousPeriod(r.from, r.to);
  const [now, prev] = await Promise.all([profitAndLoss(db, ctx.company.id, r.from, r.to), profitAndLoss(db, ctx.company.id, pp.from, pp.to)]);
  const accountant = (await getViewMode()) === "accountant";
  const x = explainChange(now, prev);
  const ch = pct(now.netProfit, prev.netProfit);
  const link = (a: Bal) => `/reports/ledger/${a.id}?from=${r.from}&to=${r.to}`;
  const empty = now.netSales.isZero() && now.expensesTotal.isZero();

  return <>
    <PageHeader title={accountant ? "Profit & loss account" : "Did I make money?"} subtitle={`${fmtDate(r.from)} to ${fmtDate(r.to)} · compared with ${fmtDate(pp.from)} to ${fmtDate(pp.to)}`}
      action={<a className="rounded-lg border border-line bg-surface px-4 py-2" href={`/reports/export?from=${r.from}&to=${r.to}`}>Download Excel</a>} />
    <div className="mb-6"><RangePicker current={r.key} /></div>
    {!now.reconciles && <Card className="mb-6"><Status tone="bad">These figures don&rsquo;t reconcile. Check System health.</Status></Card>}

    {!accountant ? <>
      <Card className="mb-6">
        <p className="text-[14px] text-ink-2">{now.netProfit.gte(0) ? "Profit" : "Loss"} in this period</p>
        <p className={`num mt-1 text-[38px] font-semibold ${now.netProfit.lt(0) ? "text-bad" : ""}`}>{formatINRShort(now.netProfit.abs())}</p>
        <p className="mt-1 text-[17px] text-ink-2">{empty ? "Nothing recorded in this period." : ch ? `That's ${ch.abs().toFixed(0)}% ${ch.gte(0) ? "higher" : "lower"} than the previous period (${formatINRShort(prev.netProfit)}).` : prev.netProfit.isZero() ? "Nothing to compare with in the previous period." : ""}</p>
        {now.netMargin && <p className="mt-1 text-ink-2">Out of every ₹100 of sales, you kept <b>₹{now.netMargin.toFixed(1)}</b> as profit after all costs.</p>}
      </Card>
      {!empty && <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card><h2 className="text-[17px] font-semibold">Where the profit came from</h2>
          <dl className="mt-3 space-y-2 text-[15px]">
            <div className="flex justify-between"><dt>Sales (after returns)</dt><dd className="num">{formatINR(now.netSales)}</dd></div>
            <div className="flex justify-between text-ink-2"><dt>Cost of the goods you sold</dt><dd className="num">−{formatINR(now.cogsTotal.plus(now.directTotal))}</dd></div>
            <div className="flex justify-between border-t border-line pt-2 font-semibold"><dt>Profit on goods</dt><dd className="num">{formatINR(now.grossProfit)}</dd></div>
            {now.grossMargin && <p className="text-[13px] text-ink-3">{now.grossMargin.toFixed(1)}% margin on sales{prev.grossMargin && ` (was ${prev.grossMargin.toFixed(1)}%)`}</p>}
            {!now.otherIncomeTotal.isZero() && <div className="flex justify-between text-ink-2"><dt>Other income</dt><dd className="num">+{formatINR(now.otherIncomeTotal)}</dd></div>}
            <div className="flex justify-between text-ink-2"><dt>Running costs</dt><dd className="num">−{formatINR(now.expensesTotal)}</dd></div>
            <div className="flex justify-between border-t border-ink pt-2 text-[18px] font-semibold"><dt>Profit</dt><dd className="num">{formatINR(now.netProfit)}</dd></div>
          </dl></Card>
        <Card><h2 className="text-[17px] font-semibold">Why it changed</h2>
          {prev.netSales.isZero() && prev.expensesTotal.isZero() ? <p className="mt-2 text-ink-2">No records in the previous period to compare with.</p> : <>
          <p className="mt-1 text-ink-2">Profit {x.change.gte(0) ? "rose" : "fell"} by {formatINR(x.change.abs())}. Each line is worked out from your records, and they add up exactly:</p>
          <ul className="mt-3 space-y-1.5 text-[15px]">{x.parts.filter((p) => !p.effect.isZero()).slice(0, 6).map((p) => <li key={p.label} className="flex justify-between gap-3">
            <span>{p.label}</span><span className={`num ${p.effect.lt(0) ? "text-bad" : "text-good"}`}>{p.effect.gte(0) ? "+" : "−"}{formatINR(p.effect.abs())}</span></li>)}</ul></>}
        </Card>
      </div>}
      {!empty && <Card><h2 className="text-[17px] font-semibold">Running costs</h2>
        <ul className="mt-3 space-y-2">{now.expenses.map((e) => { const p = prev.expenses.find((q) => q.id === e.id); const c = p ? pct(e.amount, p.amount) : null;
          return <li key={e.id}><div className="flex justify-between text-[15px]"><Link className="hover:underline" href={link(e)}>{e.owner_label}</Link>
            <span className="num">{formatINR(e.amount)}{c && c.abs().gte(10) && <span className={`ml-2 text-[13px] ${c.gt(0) ? "text-warn" : "text-good"}`}>{c.gt(0) ? "↑" : "↓"}{c.abs().toFixed(0)}%</span>}</span></div>
            <div className="mt-1 h-1.5 rounded-full bg-surface-2"><div className="h-1.5 rounded-full bg-ink-3" style={{ width: `${now.expensesTotal.isZero() ? 0 : e.amount.div(now.expensesTotal).mul(100).toFixed(1)}%` }} /></div></li>; })}</ul></Card>}
    </> :
    <Card className="overflow-x-auto"><table className="w-full min-w-[560px] text-[14px]"><caption className="sr-only">Profit and loss</caption>
      <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Particulars</th><th className="pb-2 text-right">This period</th><th className="pb-2 text-right">Previous</th></tr></thead>
      <tbody>
        <tr className="bg-surface-2"><td colSpan={3} className="px-1 py-1 font-semibold">Trading account</td></tr>
        <Tr l="Sales" a={now.sales} b={prev.sales} /><Tr l="Less: sales returns" a={now.returns.neg()} b={prev.returns.neg()} />
        <Tr l="Net sales" a={now.netSales} b={prev.netSales} bold />
        {now.cogs.map((c) => <Tr key={c.id} l={`Less: ${c.name}`} a={c.amount.neg()} b={(prev.cogs.find((q) => q.id === c.id)?.amount ?? c.amount.mul(0)).neg()} href={link(c)} />)}
        {now.direct.map((c) => <Tr key={c.id} l={`Less: ${c.name}`} a={c.amount.neg()} b={(prev.direct.find((q) => q.id === c.id)?.amount ?? c.amount.mul(0)).neg()} href={link(c)} />)}
        <Tr l="Gross profit" a={now.grossProfit} b={prev.grossProfit} bold />
        <tr className="bg-surface-2"><td colSpan={3} className="px-1 py-1 font-semibold">Profit &amp; loss account</td></tr>
        {now.otherIncome.map((c) => <Tr key={c.id} l={`Add: ${c.name}`} a={c.amount} b={prev.otherIncome.find((q) => q.id === c.id)?.amount ?? c.amount.mul(0)} href={link(c)} />)}
        {now.expenses.map((c) => <Tr key={c.id} l={`Less: ${c.name}`} a={c.amount.neg()} b={(prev.expenses.find((q) => q.id === c.id)?.amount ?? c.amount.mul(0)).neg()} href={link(c)} />)}
        <Tr l="Net profit" a={now.netProfit} b={prev.netProfit} bold top />
      </tbody></table>
      <p className="mt-3 text-[13px] text-ink-3">Gross margin {now.grossMargin?.toFixed(2) ?? "—"}% · net margin {now.netMargin?.toFixed(2) ?? "—"}%. Stock is valued at weighted average cost; cost of goods sold is recorded with each sale.</p></Card>}
  </>;
}
function Tr({ l, a, b, bold, top, href }: { l: string; a: Decimal; b: Decimal; bold?: boolean; top?: boolean; href?: string }) {
  return <tr className={`${top ? "border-t-2 border-ink" : "border-t border-line"} ${bold ? "font-semibold" : ""}`}>
    <td className="py-1.5">{href ? <Link className="hover:underline" href={href}>{l}</Link> : l}</td><td className="num text-right">{formatINR(a)}</td><td className="num text-right text-ink-2">{formatINR(b)}</td></tr>;
}
