import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { businessHealth } from "@/lib/analytics/health";
import { fmtDate } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui";
import { RangePicker, resolveRange } from "@/components/range-picker";
import { RatioStatus } from "@/components/status-badge";

export default async function Health({ searchParams }: { searchParams: Promise<{ range?: string; from?: string; to?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const sp = await searchParams;
  const r = resolveRange({ range: sp.range ?? "quarter", ...sp });
  const parts = await businessHealth(db, ctx.company.id, r.from, r.to);
  return <>
    <PageHeader title="How is my business doing?" subtitle={`${fmtDate(r.from)} to ${fmtDate(r.to)}`} />
    <div className="mb-3"><RangePicker current={r.key} /></div>
    <p className="mb-6 text-[13px] text-ink-3">Six plain questions, each answered from your own records. There is no single score — a score would hide which part needs attention.</p>
    <div className="grid gap-4 md:grid-cols-2">{parts.map((p) => <Card key={p.key} className="!p-5"><article>
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-[17px] font-semibold">{p.title}</h2><p className="text-[13px] text-ink-3">{p.question}</p></div><RatioStatus s={p.status} /></div>
      <p className="mt-3">{p.state}</p>
      {p.reason && <p className="mt-1 text-[14px] text-ink-2">{p.reason}</p>}
      {p.trend && <p className="mt-1 text-[14px] text-ink-2">{p.trend}</p>}
      {p.action && <p className="mt-2 text-[14px]"><b>Do this:</b> {p.action}</p>}
      <Link href={p.href} className="mt-3 inline-block text-[14px] text-brand underline">See the numbers</Link>
    </article></Card>)}</div>
  </>;
}
