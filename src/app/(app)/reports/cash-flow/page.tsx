import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { cashFlow } from "@/lib/accounting/statements";
import { formatINR, formatINRShort } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Card, PageHeader, Status } from "@/components/ui";
import { RangePicker, resolveRange } from "@/components/range-picker";

export default async function CashFlowPage({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const r = resolveRange(await searchParams);
  const c = await cashFlow(db, ctx.company.id, r.from, r.to);
  const accountant = (await getViewMode()) === "accountant";
  const ins = c.direct.filter((d) => d.amount.gt(0)), outs = c.direct.filter((d) => d.amount.lt(0));
  const tot = (xs: typeof ins) => xs.reduce((s, x) => s.plus(x.amount), c.change.mul(0));
  return <>
    <PageHeader title={accountant ? "Cash flow statement" : "Where did my cash go?"} subtitle={`${fmtDate(r.from)} to ${fmtDate(r.to)} · cash and bank together`} />
    <div className="mb-6"><RangePicker current={r.key} /></div>
    <p className="mb-6">{c.reconciles ? <Status tone="good">Checked: both methods agree with your actual cash and bank balances</Status> : <Status tone="bad">Doesn&rsquo;t reconcile — check System health</Status>}</p>
    <Card className="mb-6"><div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 text-[17px]">
      <span>Start: <b className="num">{formatINRShort(c.opening)}</b></span><span className={c.change.gte(0) ? "text-good" : "text-bad"}>{c.change.gte(0) ? "+" : "−"}{formatINRShort(c.change.abs())}</span>
      <span>End: <b className="num">{formatINRShort(c.closing)}</b></span></div>
      {!accountant && <p className="mt-2 text-ink-2">{c.change.gte(0) ? "More money came in than went out." : "More money went out than came in."}
        {c.indirect.profit.gt(0) && c.change.lt(0) && " You made a profit, but cash still fell. Usually that's because money went into stock or is still with customers."}</p>}</Card>
    {!accountant ? <div className="grid gap-4 md:grid-cols-2">
      <Card><h2 className="text-[17px] font-semibold text-good">Money in · {formatINR(tot(ins).plus(c.openingBooked.gt(0) ? c.openingBooked : 0))}</h2>
        <ul className="mt-3 space-y-2 text-[15px]">{c.openingBooked.gt(0) && <li className="flex justify-between"><span>Opening balances entered</span><span className="num">{formatINR(c.openingBooked)}</span></li>}
          {ins.map((d) => <li key={d.cat} className="flex justify-between"><span>{d.label}</span><span className="num">{formatINR(d.amount)}</span></li>)}</ul></Card>
      <Card><h2 className="text-[17px] font-semibold text-bad">Money out · {formatINR(tot(outs).abs())}</h2>
        <ul className="mt-3 space-y-2 text-[15px]">{outs.sort((a, b) => a.amount.comparedTo(b.amount)).map((d) => <li key={d.cat} className="flex justify-between"><span>{d.label}</span><span className="num">{formatINR(d.amount.abs())}</span></li>)}</ul></Card>
    </div> :
    <Card><table className="w-full text-[14px]"><caption className="sr-only">Cash flow (indirect)</caption><tbody>
      <tr className="bg-surface-2"><td colSpan={2} className="px-1 py-1 font-semibold">A. Operating activities</td></tr>
      <tr className="border-t border-line"><td className="py-1">Net profit</td><td className="num text-right">{formatINR(c.indirect.profit)}</td></tr>
      {!c.indirect.depreciation.isZero() && <tr className="border-t border-line"><td className="py-1">Add: depreciation</td><td className="num text-right">{formatINR(c.indirect.depreciation)}</td></tr>}
      {c.indirect.wc.map((w) => <tr key={w.label} className="border-t border-line"><td className="py-1">{w.label}</td><td className="num text-right">{formatINR(w.amount)}</td></tr>)}
      <tr className="border-t border-ink font-semibold"><td className="py-1">Cash from operations</td><td className="num text-right">{formatINR(c.indirect.operating)}</td></tr>
      <tr className="bg-surface-2"><td colSpan={2} className="px-1 py-1 font-semibold">B. Investing activities</td></tr>
      <tr className="border-t border-line"><td className="py-1">Purchase / sale of fixed assets</td><td className="num text-right">{formatINR(c.indirect.investing)}</td></tr>
      <tr className="bg-surface-2"><td colSpan={2} className="px-1 py-1 font-semibold">C. Financing activities</td></tr>
      <tr className="border-t border-line"><td className="py-1">Capital, drawings, opening balances and loans</td><td className="num text-right">{formatINR(c.indirect.financing)}</td></tr>
      <tr className="border-t-2 border-ink font-semibold"><td className="py-1">Net change in cash &amp; bank (A+B+C)</td><td className="num text-right">{formatINR(c.indirect.net)}</td></tr>
    </tbody></table></Card>}
  </>;
}
