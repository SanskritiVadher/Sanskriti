import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { computeRatios, fmtV } from "@/lib/analytics/ratios";
import { formatINR } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Card, PageHeader } from "@/components/ui";
import { RangePicker, resolveRange } from "@/components/range-picker";
import { RatioStatus } from "@/components/status-badge";

const SRC = { YOUR_TARGET: "Your target", YOUR_HISTORY: "Your own history", YOUR_CREDIT_TERMS: "Your credit terms", GENERAL_REFERENCE: "General reference (not a rule)" };
export default async function Ratios({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const sp = await searchParams;
  const r = resolveRange({ range: sp.range ?? "quarter", ...sp });
  const { ratios, previousPeriod } = await computeRatios(db, ctx.company.id, r.from, r.to);
  const accountant = (await getViewMode()) === "accountant";
  const groups = [...new Set(ratios.map((x) => x.group))];
  return <>
    <PageHeader title={accountant ? "Ratio analysis" : "How healthy are my numbers?"} subtitle={`${fmtDate(r.from)} to ${fmtDate(r.to)} · compared with ${fmtDate(previousPeriod.from)}–${fmtDate(previousPeriod.to)}`} />
    <div className="mb-3"><RangePicker current={r.key} /></div>
    <p className="mb-6 text-[13px] text-ink-3">Yearly figures are scaled up from this period. Every number comes from your records; open &ldquo;Show me why&rdquo; to see exactly how.</p>
    {accountant ? <Card className="overflow-x-auto"><table className="w-full min-w-[760px] text-[14px]"><caption className="sr-only">Ratios</caption>
      <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Ratio</th><th className="pb-2 text-right">Value</th><th className="pb-2 text-right">Previous</th><th className="pb-2 text-right">Usual</th><th className="pb-2">Benchmark</th><th className="pb-2">Status</th><th className="pb-2">Formula</th></tr></thead>
      <tbody>{ratios.map((x) => <tr key={x.key} className="border-t border-line align-top">
        <td className="py-2">{x.name}<span className="block text-[11px] text-ink-3">{x.group}</span></td>
        <td className="num text-right">{x.value ? fmtV(x.value, x.unit) : "—"}</td><td className="num text-right text-ink-2">{x.previous ? fmtV(x.previous, x.unit) : "—"}</td>
        <td className="num text-right text-ink-2">{x.usual ? fmtV(x.usual, x.unit) : "—"}</td>
        <td className="text-[12px]">{x.benchmark ? `${fmtV(x.benchmark.value, x.unit)} · ${SRC[x.benchmark.source]}` : "—"}</td>
        <td>{x.value ? <RatioStatus s={x.status} /> : <RatioStatus s="NO_DATA" />}</td>
        <td className="text-[12px] text-ink-2">{x.formula}{x.numerator && x.denominator && <span className="block">{formatINR(x.numerator.value)} ÷ {formatINR(x.denominator.value)}</span>}</td></tr>)}</tbody></table></Card>
    : groups.map((g) => <section key={g} className="mb-8"><h2 className="mb-3 text-[15px] font-semibold text-ink-2">{g}</h2>
      <div className="grid gap-4 md:grid-cols-2">{ratios.filter((x) => x.group === g).map((x) => <Card key={x.key} className="!p-5"><article id={x.key}>
        <div className="flex items-start justify-between gap-3"><div><h3 className="text-[16px] font-semibold uppercase tracking-wide text-ink-2">{x.ownerName}</h3>
          <p className="num mt-1 text-[28px] font-semibold">{x.value ? fmtV(x.value, x.unit) : "—"}</p></div><RatioStatus s={x.value ? x.status : "NO_DATA"} /></div>
        {x.value ? <>
          <p className="mt-2">{x.meaning}</p>
          <dl className="mt-3 grid grid-cols-3 gap-2 text-[13px]">
            <div><dt className="text-ink-3">Your usual</dt><dd className="num">{x.usual ? fmtV(x.usual, x.unit) : "not enough history"}</dd></div>
            <div><dt className="text-ink-3">Previous period</dt><dd className="num">{x.previous ? <>{fmtV(x.previous, x.unit)} {x.previous.lt(x.value) ? "↑" : x.previous.gt(x.value) ? "↓" : "→"}</> : "—"}</dd></div>
            <div><dt className="text-ink-3">{x.benchmark ? SRC[x.benchmark.source] : "Benchmark"}</dt><dd className="num">{x.benchmark ? fmtV(x.benchmark.value, x.unit) : "—"}</dd></div>
          </dl>
          {x.statusReason && <p className="mt-2 text-[14px] text-ink-2"><b>Why this status:</b> {x.statusReason}</p>}
          {x.why && <p className="mt-1 text-[14px] text-ink-2"><b>What changed:</b> {x.why}</p>}
          {x.watch && <p className="mt-1 text-[14px]"><b>What to watch:</b> {x.watch}</p>}
          <details className="mt-3 text-[13px] text-ink-2"><summary className="cursor-pointer text-brand">Show me why</summary>
            <p className="mt-2">{x.name}: {x.formula}</p>
            {x.numerator && x.denominator && <p>{x.numerator.label} {formatINR(x.numerator.value)} ÷ {x.denominator.label} {formatINR(x.denominator.value)}</p>}
            <p>From: {x.sources.join("; ")}.</p>{x.benchmark && <p>Benchmark: {x.benchmark.note}.</p>}</details>
        </> : <p className="mt-2 text-[14px] text-ink-2">{x.insufficient}</p>}
      </article></Card>)}</div></section>)}
  </>;
}
