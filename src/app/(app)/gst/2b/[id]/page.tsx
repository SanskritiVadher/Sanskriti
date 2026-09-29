import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { reconcile2b } from "@/lib/services/gst";
import { formatINR } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Card, PageHeader, Status } from "@/components/ui";

const TONE = { MATCHED: ["good", "Matched"], AMOUNT_DIFF: ["warn", "Amount differs"], NOT_IN_2B: ["warn", "Supplier hasn't filed"], NOT_IN_BOOKS: ["info", "Not in your books"] } as const;
export default async function TwoBResult({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireContext("gst.configure");
  const r = await reconcile2b(db, ctx.company.id, (await params).id);
  if (!r) notFound();
  const order = ["AMOUNT_DIFF", "NOT_IN_2B", "NOT_IN_BOOKS", "MATCHED"];
  return <>
    <PageHeader title={`GSTR-2B match · ${r.per.label}`} subtitle={r.imp.fileName} />
    <Card className="mb-6">
      <p className="flex flex-wrap gap-2"><Status tone="good">{r.counts.matched} matched</Status><Status tone="warn">{r.counts.diff} amount differs</Status>
        <Status tone="warn">{r.counts.notIn2b} supplier hasn&rsquo;t filed</Status><Status tone="info">{r.counts.notInBooks} not in your books</Status></p>
      <p className="mt-3 text-ink-2">{r.riskTax.gt(0) ? `${formatINR(r.riskTax)} of GST credit on your purchases can't safely be claimed yet. Call those suppliers first.` : "All your purchase GST for this month is reflected on the portal."}</p>
    </Card>
    <Card className="overflow-x-auto"><table className="w-full min-w-[720px] text-[14px]"><caption className="sr-only">Matches</caption>
      <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Status</th><th className="pb-2">Supplier</th><th className="pb-2">Bill</th><th className="pb-2">Date</th><th className="pb-2 text-right">GST (books)</th><th className="pb-2 text-right">GST (portal)</th><th className="pb-2">What to do</th></tr></thead>
      <tbody>{[...r.rows].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).map((x, i) => <tr key={i} className="border-t border-line align-top">
        <td className="py-2"><Status tone={TONE[x.status][0]}>{TONE[x.status][1]}</Status></td>
        <td>{x.supplier}<span className="block text-[11px] text-ink-3">{x.gstin}</span></td>
        <td>{x.billId ? <Link className="hover:underline" href={`/buy/${x.billId}`}>{x.number}</Link> : x.number}</td>
        <td className="whitespace-nowrap">{fmtDate(x.date)}</td>
        <td className="num text-right">{x.books ? formatINR(x.books) : "—"}</td><td className="num text-right">{x.portal ? formatINR(x.portal) : "—"}</td>
        <td className="text-ink-2">{x.note}</td></tr>)}</tbody></table></Card>
  </>;
}
