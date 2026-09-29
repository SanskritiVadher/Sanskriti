import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { fmtDate } from "@/lib/dates";
import { findings, KIND_LABEL, type Finding } from "@/lib/analytics/anomalies";
import { Button, Card, Input, Notice, PageHeader, Status } from "@/components/ui";
import { markCheckedAction } from "../../../actions-phase8";

const tone = (t: Finding["tone"]) => (t === "bad" ? "bad" : t === "warn" ? "warn" : "info") as "bad" | "warn" | "info";
export default async function Checks({ searchParams }: { searchParams: Promise<{ ok?: string; all?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const sp = await searchParams;
  const r = await findings(db, ctx.company.id, undefined, { includeChecked: !!sp.all });
  return <>
    <PageHeader title="Things that look unusual" subtitle={`${fmtDate(r.from)} to ${fmtDate(r.asOf)} · fixed rules, checked against your own records`} />
    {sp.ok && <div className="mb-4"><Notice tone="good" title="Marked as checked." /></div>}
    <p className="mb-4 text-[14px] text-ink-2">These are questions, not mistakes. If you&rsquo;ve looked and it&rsquo;s fine, mark it checked — it won&rsquo;t show again, and the audit trail records who checked it.</p>
    {r.open.length === 0 ? <Card><Status tone="good">Nothing unusual found.</Status></Card> :
    <div className="space-y-3">{r.open.map((f) => <Card key={f.key} className="!p-4">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-3xl">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-ink-3">{KIND_LABEL[f.kind]}</p>
        <p className="mt-1 font-medium">{f.what}</p><p className="text-[14px] text-ink-2">{f.why} <span className="text-ink">{f.action}</span></p></div>
        <Status tone={tone(f.tone)}>{f.tone === "bad" ? "Check now" : f.tone === "warn" ? "Check" : "Worth a look"}</Status></div>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Link href={f.href} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[14px]">Open</Link>
        <form action={markCheckedAction} className="flex flex-wrap gap-2"><input type="hidden" name="key" value={f.key} />
          <Input name="note" placeholder="Why it's fine (optional)" className="!w-60 !py-1.5 text-[14px]" maxLength={200} /><Button variant="secondary">Checked, it&rsquo;s fine</Button></form></div>
    </Card>)}</div>}
    {r.checked.length > 0 && <><h2 className="mt-8 mb-2 text-[15px] font-semibold text-ink-2">Already checked</h2>
      <ul className="space-y-1 text-[14px] text-ink-2">{r.checked.map((f) => <li key={f.key}>{KIND_LABEL[f.kind]} — {f.what}</li>)}</ul></>}
    {!sp.all && <p className="mt-6 text-[14px]"><Link className="text-brand underline" href="/assistant/checks?all=1">Show ones already checked</Link></p>}
  </>;
}
