import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { fmtDate } from "@/lib/dates";
import { formatINRShort } from "@/lib/money";
import { weeklyReview } from "@/lib/services/brief";
import { Card, PageHeader } from "@/components/ui";

export default async function Week() {
  const ctx = await requireContext("reports.financial");
  const w = await weeklyReview(db, ctx.company.id);
  const phone = (ctx.company.phone ?? "").replace(/\D/g, "").slice(-10);
  const wa = `https://wa.me/${phone.length === 10 ? "91" + phone : ""}?text=${encodeURIComponent(w.text)}`;
  return <>
    <PageHeader title="This week" subtitle={`${fmtDate(w.from)} to ${fmtDate(w.to)}, compared with ${fmtDate(w.pfrom)} to ${fmtDate(w.pto)}`} action={<a href={wa} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-line bg-surface px-4 py-2 text-[14px]">Send to my WhatsApp</a>} />
    <Card className="mb-6 overflow-x-auto"><table className="w-full min-w-[480px] text-[15px]"><thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2" /><th className="pb-2 text-right">This week</th><th className="pb-2 text-right">Week before</th><th className="pb-2 text-right">Change</th></tr></thead>
      <tbody>{w.rows.map((r) => { const better = r.pct && (r.good === "up" ? r.pct.gt(0) : r.pct.lt(0)); return <tr key={r.label} className="border-t border-line">
        <td className="py-2">{r.label}</td><td className="num text-right">{formatINRShort(r.now)}</td><td className="num text-right text-ink-2">{formatINRShort(r.prev)}</td>
        <td className={`num text-right ${r.pct && !r.pct.isZero() ? (better ? "text-good" : "text-warn") : "text-ink-3"}`}>{r.pct ? `${r.pct.gte(0) ? "+" : ""}${r.pct.toFixed(0)}%` : "—"}</td></tr>; })}</tbody></table>
      {w.marginNow && <p className="mt-3 text-[14px] text-ink-2">Margin on goods: {w.marginNow.toFixed(1)}%{w.marginPrev ? ` (was ${w.marginPrev.toFixed(1)}%)` : ""}.</p>}</Card>
    {w.notes.length > 0 && <Card className="mb-6"><h2 className="text-[17px] font-semibold">Worth noticing</h2><ul className="mt-2 list-disc space-y-1 pl-5">{w.notes.map((n) => <li key={n}>{n}</li>)}</ul></Card>}
    <div className="grid gap-4 md:grid-cols-2">
      <Card><h2 className="text-[17px] font-semibold">Biggest customers this week</h2>{w.topCustomers.length ? <ul className="mt-2 space-y-1 text-[14px]">{w.topCustomers.map((c) => <li key={c.id} className="flex justify-between gap-2"><Link className="hover:underline" href={`/customers/${c.id}`}>{c.name}</Link><span className="num">{formatINRShort(c.sales)}</span></li>)}</ul> : <p className="mt-2 text-[14px] text-ink-2">No sales this week.</p>}</Card>
      <Card><h2 className="text-[17px] font-semibold">Most profit this week</h2>{w.topProducts.length ? <ul className="mt-2 space-y-1 text-[14px]">{w.topProducts.map((c) => <li key={c.id} className="flex justify-between gap-2"><span>{c.name}</span><span className="num">{formatINRShort(c.profit)}</span></li>)}</ul> : <p className="mt-2 text-[14px] text-ink-2">No sales this week.</p>}
        {w.weakProducts.length > 0 && <p className="mt-3 text-[14px] text-warn">Low or no margin: {w.weakProducts.map((p) => p.name).join(", ")}. <Link className="underline" href="/reports/profitability">See why</Link></p>}</Card>
    </div>
  </>;
}
