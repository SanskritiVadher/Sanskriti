import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { latest2b, parsePeriod } from "@/lib/services/gst";
import { todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, PageHeader } from "@/components/ui";
import { periodOptions } from "@/components/gst/period-picker";
import { upload2bAction } from "@/app/actions-phase5";

export default async function TwoB({ searchParams }: { searchParams: Promise<{ period?: string; error?: string }> }) {
  const ctx = await requireContext("gst.configure");
  const sp = await searchParams;
  const list = await latest2b(db, ctx.company.id);
  const { months } = periodOptions();
  const def = sp.period && /^\d{4}-\d{2}$/.test(sp.period) ? sp.period : months[1]?.v ?? todayIST().slice(0, 7);
  return <>
    <PageHeader title="Match suppliers' filings (GSTR-2B)" subtitle="Check that GST you paid on purchases shows up on the portal, so you can claim it." />
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card className="mb-6"><form action={upload2bAction} className="grid gap-4 sm:grid-cols-3">
      <Field label="For month"><select name="period" defaultValue={def} className="w-full rounded-lg border border-line bg-surface px-3 py-2.5">{months.map((m) => <option key={m.v} value={m.v}>{m.l}</option>)}</select></Field>
      <div className="sm:col-span-2"><Field label="GSTR-2B JSON file" hint="Not Excel or PDF — the JSON download"><Input type="file" name="file" accept=".json,application/json" required /></Field></div>
      <div className="sm:col-span-3"><Button>Upload and match</Button></div>
    </form></Card>
    <Card className="mb-6"><h2 className="font-semibold">How to get the file</h2>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-[15px] text-ink-2">
        <li>Log in at gst.gov.in → Services → Returns → Returns Dashboard.</li><li>Choose the financial year and month, then open <b>GSTR-2B</b> → <b>Download</b>.</li>
        <li>Choose <b>Generate JSON file to download</b>, then upload that file here.</li></ol>
      <p className="mt-2 text-[13px] text-ink-3">GSTR-2A JSON also works. Your data stays in this app; nothing is sent to the portal.</p></Card>
    {list.length > 0 && <Card><h2 className="font-semibold">Earlier uploads</h2><ul className="mt-2 divide-y divide-line">{list.map((i) =>
      <li key={i.id} className="flex justify-between py-2"><Link className="text-brand underline" href={`/gst/2b/${i.id}`}>{parsePeriod(i.period).label}</Link>
        <span className="text-[14px] text-ink-3">{(i.docs as unknown[]).length} bills · {i.fileName}</span></li>)}</ul></Card>}
  </>;
}
