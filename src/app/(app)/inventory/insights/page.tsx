import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { stockInsights, type Health } from "@/lib/analytics/stock";
import { formatINR, formatINRShort } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Card, LinkButton, PageHeader, Status } from "@/components/ui";

const H: Record<Health, { tone: "good" | "warn" | "bad" | "info" | "neutral"; l: string }> = {
  OUT: { tone: "bad", l: "Out of stock" }, LOW: { tone: "warn", l: "Running low" }, HEALTHY: { tone: "good", l: "Healthy" },
  OVERSTOCK: { tone: "info", l: "More than needed" }, SLOW: { tone: "warn", l: "Slow-moving" }, DEAD: { tone: "bad", l: "Not moving" }, NEW: { tone: "neutral", l: "New" } };
export default async function Insights() {
  const ctx = await requireContext("view.dashboard");
  const s = await stockInsights(db, ctx.company.id);
  const reorder = s.items.filter((x) => x.health === "OUT" || x.health === "LOW").sort((a, b) => (a.daysLeft?.toNumber() ?? -1) - (b.daysLeft?.toNumber() ?? -1));
  const stuck = s.items.filter((x) => x.health === "DEAD" || x.health === "SLOW" || x.health === "OVERSTOCK").sort((a, b) => b.value.comparedTo(a.value));
  const fast = s.items.filter((x) => x.recentVsUsual?.gte(1.3));
  return <>
    <PageHeader title="Stock health" subtitle={`Based on sales since ${fmtDate(s.lookbackFrom)}`} action={<LinkButton href="/settings/targets" variant="secondary">Reorder settings</LinkButton>} />
    <div className="mb-6 grid gap-4 md:grid-cols-3">
      <Card><p className="text-[14px] text-ink-2">Needs ordering</p><p className="mt-1 text-[28px] font-semibold">{s.summary.counts.OUT + s.summary.counts.LOW}</p>
        <p className="text-[14px] text-ink-2">{s.summary.counts.OUT} out, {s.summary.counts.LOW} running low</p></Card>
      <Card><p className="text-[14px] text-ink-2">Money stuck in stock</p><p className="num mt-1 text-[28px] font-semibold">{formatINRShort(s.summary.slowValue.plus(s.summary.overValue))}</p>
        <p className="text-[14px] text-ink-2">{formatINRShort(s.summary.slowValue)} slow or not moving, {formatINRShort(s.summary.overValue)} more than needed</p></Card>
      <Card><p className="text-[14px] text-ink-2">Selling faster than usual</p><p className="mt-1 text-[28px] font-semibold">{fast.length}</p>
        <p className="text-[14px] text-ink-2">{fast.slice(0, 2).map((x) => x.name).join(", ") || "None"}</p></Card>
    </div>
    <Card className="mb-6 overflow-x-auto"><h2 className="text-[18px] font-semibold">What should I buy?</h2>
      <p className="mb-3 text-[13px] text-ink-3">Suggested quantity covers {s.settings.leadDays} days&rsquo; delivery time + {s.settings.coverDays} days of sales + {s.settings.safetyDays} days&rsquo; safety stock, at the usual pace.
        <b> Forecast</b> = worked out from your sales history; shown only with enough history. Otherwise your own reorder level is used.</p>
      {reorder.length === 0 ? <p><Status tone="good">Nothing needs ordering right now.</Status></p> :
      <table className="w-full min-w-[680px] text-[14px]"><caption className="sr-only">Reorder</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Product</th><th className="pb-2 text-right">In stock <span className="font-normal">(actual)</span></th><th className="pb-2 text-right">Sells per day <span className="font-normal">(estimate)</span></th>
          <th className="pb-2 text-right">Days left <span className="font-normal">(estimate)</span></th><th className="pb-2 text-right">Suggested order <span className="font-normal">(forecast)</span></th><th className="pb-2">Basis</th></tr></thead>
        <tbody>{reorder.map((x) => <tr key={x.id} className="border-t border-line">
          <td className="py-2"><Link className="hover:underline" href={`/inventory/${x.id}`}>{x.name}</Link>{x.brand && <span className="block text-[11px] text-ink-3">{x.brand}</span>}</td>
          <td className="num text-right">{x.qty.toString()} {x.unit}</td><td className="num text-right">{x.avgDaily?.toString() ?? "—"}</td>
          <td className="num text-right">{x.daysLeft?.toString() ?? "—"}</td><td className="num text-right font-semibold">{x.suggestQty ? `${x.suggestQty} ${x.unit}` : "—"}</td>
          <td className="text-[12px]">{x.basis === "FORECAST" ? "From sales history" : x.basis === "YOUR_REORDER_LEVEL" ? "Your reorder level (not enough history to forecast)" : "Not enough history"}</td></tr>)}</tbody></table>}
    </Card>
    <Card className="mb-6 overflow-x-auto"><h2 className="text-[18px] font-semibold">Money stuck in stock</h2>
      {stuck.length === 0 ? <p className="mt-2"><Status tone="good">No slow or excess stock.</Status></p> :
      <table className="mt-3 w-full min-w-[600px] text-[14px]"><caption className="sr-only">Stuck stock</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Product</th><th className="pb-2">Status</th><th className="pb-2 text-right">Value</th><th className="pb-2 text-right">Oldest unit</th><th className="pb-2">Note</th></tr></thead>
        <tbody>{stuck.map((x) => <tr key={x.id} className="border-t border-line align-top">
          <td className="py-2"><Link className="hover:underline" href={`/inventory/${x.id}`}>{x.name}</Link></td><td><Status tone={H[x.health].tone}>{H[x.health].l}</Status></td>
          <td className="num text-right">{formatINR(x.value)}</td><td className="num text-right">{x.oldestUnitDays != null ? `${x.oldestUnitDays} days` : "—"}</td><td className="text-ink-2">{x.note}</td></tr>)}</tbody></table>}
      {stuck.length > 0 && <p className="mt-3 text-[14px] text-ink-2">Ideas: offer these to regular customers, return them to the supplier if the scheme allows, or stop reordering them.</p>}
    </Card>
    <Card className="overflow-x-auto"><h2 className="text-[18px] font-semibold">All products</h2>
      <table className="mt-3 w-full min-w-[600px] text-[14px]"><caption className="sr-only">All</caption><tbody>{s.items.map((x) => <tr key={x.id} className="border-t border-line">
        <td className="py-2"><Link className="hover:underline" href={`/inventory/${x.id}`}>{x.name}</Link></td><td><Status tone={H[x.health].tone}>{H[x.health].l}</Status></td>
        <td className="num text-right">{x.qty.toString()} {x.unit}</td><td className="text-ink-2">{x.note}</td></tr>)}</tbody></table></Card>
  </>;
}
