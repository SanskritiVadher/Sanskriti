import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { profitability, type By } from "@/lib/analytics/profitability";
import { formatINR, formatINRShort } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Card, PageHeader, Status } from "@/components/ui";
import { RangePicker, resolveRange } from "@/components/range-picker";

const TABS: { k: By; l: string }[] = [{ k: "product", l: "Products" }, { k: "brand", l: "Brands" }, { k: "customer", l: "Customers" }, { k: "salesperson", l: "Staff" }];
export default async function Profitability({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string; by?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const sp = await searchParams;
  const r = resolveRange({ range: sp.range ?? "quarter", ...sp });
  const by = (TABS.find((t) => t.k === sp.by)?.k ?? "product") as By;
  const d = await profitability(db, ctx.company.id, r.from, r.to, by);
  const top = d.rows[0], flagged = d.rows.filter((x) => x.flag && x.flag !== "Better than average margin");
  const q = (k: By) => `?${new URLSearchParams({ by: k, from: r.from, to: r.to })}`;
  return <>
    <PageHeader title="Where am I making money?" subtitle={`${fmtDate(r.from)} to ${fmtDate(r.to)} · profit on goods (sales − their cost), after returns`} />
    <div className="mb-4"><RangePicker current={r.key} /></div>
    <nav className="mb-6 flex gap-2" aria-label="Group by">{TABS.map((t) => <Link key={t.k} href={q(t.k)} className={`rounded-lg px-4 py-2 ${t.k === by ? "bg-brand text-brand-ink" : "border border-line bg-surface"}`}>{t.l}</Link>)}</nav>
    {d.rows.length === 0 ? <Card><p className="text-ink-2">No sales in this period.</p></Card> : <>
      <Card className="mb-6"><p className="text-[17px]">Profit on goods: <b className="num">{formatINRShort(d.totProfit)}</b> from sales of <b className="num">{formatINRShort(d.totSales)}</b>{d.avgMargin && <> — an average margin of <b>{d.avgMargin.toFixed(1)}%</b></>}.</p>
        {top && top.profit.gt(0) && <p className="mt-2 text-ink-2">{top.name} made the most: {formatINRShort(top.profit)} ({top.share.toFixed(0)}% of all profit) from {formatINRShort(top.sales)} of sales.</p>}
        {flagged.length > 0 && <ul className="mt-3 space-y-1">{flagged.slice(0, 4).map((x) => <li key={x.id}><Status tone={x.flag === "Losing money" ? "bad" : "warn"}>{x.flag}</Status> <span className="ml-1">{x.name}: {x.margin?.toFixed(1)}% margin on {formatINRShort(x.sales)}</span></li>)}</ul>}
      </Card>
      <Card className="overflow-x-auto"><table className="w-full min-w-[640px] text-[14px]"><caption className="sr-only">Profitability</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">{TABS.find((t) => t.k === by)!.l.replace(/s$/, "")}</th><th className="pb-2 text-right">Sales</th><th className="pb-2 text-right">Profit</th>
          <th className="pb-2 text-right">Margin</th><th className="pb-2">Share of profit</th>{by === "product" && <th className="pb-2 text-right">Qty</th>}<th className="pb-2" /></tr></thead>
        <tbody>{d.rows.map((x) => <tr key={x.id} className="border-t border-line">
          <td className="py-2">{by === "product" ? <Link className="hover:underline" href={`/inventory/${x.id}`}>{x.name}</Link> : by === "customer" ? <Link className="hover:underline" href={`/customers/${x.id}`}>{x.name}</Link> : x.name}</td>
          <td className="num text-right">{formatINR(x.sales)}</td><td className={`num text-right ${x.profit.lt(0) ? "text-bad" : ""}`}>{formatINR(x.profit)}</td>
          <td className="num text-right">{x.margin ? `${x.margin.toFixed(1)}%` : "—"}</td>
          <td><div className="h-2 w-32 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, Number(x.share.toFixed(1))))}%` }} /></div></td>
          {by === "product" && <td className="num text-right">{x.qty.toString()}</td>}
          <td>{x.flag && <Status tone={x.flag === "Better than average margin" ? "good" : x.flag === "Losing money" ? "bad" : "warn"}>{x.flag}</Status>}</td></tr>)}</tbody></table>
        <p className="mt-3 text-[13px] text-ink-3">Running costs (rent, salaries…) are not split by product or customer, so this is profit before those costs. Total matches &ldquo;Profit on goods&rdquo; in the P&amp;L.</p></Card>
    </>}
  </>;
}
