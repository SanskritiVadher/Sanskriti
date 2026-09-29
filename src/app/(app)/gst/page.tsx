import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { parsePeriod, gstr3b, gstReview, gstLedgerPosition, latest2b, reconcile2b } from "@/lib/services/gst";
import { formatINR, formatINRShort } from "@/lib/money";
import { todayIST } from "@/lib/dates";
import { Card, LinkButton, Notice, PageHeader, Status } from "@/components/ui";
import { PeriodPicker } from "@/components/gst/period-picker";

export default async function Gst({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const period = sp.period ?? todayIST().slice(0, 7);
  const per = parsePeriod(period);
  if (ctx.company.gstRegistration !== "REGULAR") return <>
    <PageHeader title="GST" subtitle="Is my GST in order?" />
    <Notice tone="info" title="Your business is set as not regular-registered under GST.">Bills are made without GST. If you are registered, update it in Settings → GST.</Notice>
  </>;
  const [r, review, ledger, imports] = await Promise.all([gstr3b(db, ctx.company.id, per), gstReview(db, ctx.company.id, per),
    gstLedgerPosition(db, ctx.company.id, per.to), latest2b(db, ctx.company.id)]);
  const collected = r.out.igst.plus(r.out.cgst).plus(r.out.sgst);
  const input = r.inp.igst.plus(r.inp.cgst).plus(r.inp.sgst);
  const imp = imports.find((i) => i.period === period);
  const rec = imp ? await reconcile2b(db, ctx.company.id, imp.id) : null;
  const edit = can(ctx.role, "gst.configure");

  return <>
    <PageHeader title="GST" subtitle="Is my GST in order?" action={<PeriodPicker value={period} />} />
    <Card className="mb-6">
      <p className="text-[14px] text-ink-2">GST position · {per.label}</p>
      <ul className="mt-3 space-y-2 text-[17px]">
        <li>You collected <b className="num">{formatINR(collected)}</b> of GST from customers <span className="text-[14px] text-ink-3">(after returns)</span>.</li>
        <li>You have <b className="num">{formatINR(input)}</b> of GST on purchases you can claim back <span className="text-[14px] text-ink-3">(from {r.inp.bills} bill{r.inp.bills === 1 ? "" : "s"}, after returns)</span>.
          {rec && rec.riskTax.gt(0) && <span className="block text-[15px] text-warn">⚠ {formatINR(rec.riskTax)} of this isn&rsquo;t on the portal (2B) yet, so it may not be claimable this month.</span>}
          {!rec && <span className="block text-[14px] text-ink-3">Not yet checked against the portal (2B).</span>}</li>
        <li>Estimated to pay in cash for this period: <b className="num">{formatINR(r.setoff.cashTotal)}</b>
          {r.setoff.carryForward.igst.plus(r.setoff.carryForward.cgst).plus(r.setoff.carryForward.sgst).gt(0) && <span className="text-ink-2"> · credit left for next period {formatINR(r.setoff.carryForward.igst.plus(r.setoff.carryForward.cgst).plus(r.setoff.carryForward.sgst))}</span>}</li>
      </ul>
      <p className="mt-3 text-[13px] text-ink-3">Estimate from your recorded bills only. The portal&rsquo;s own figures (and any late supplier filings in 2B) decide the final amount. Your books show {formatINRShort(ledger.setoff.cashTotal)} unpaid GST up to {per.label.split(" – ").pop()}, including earlier periods.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <LinkButton href={`/gst/returns?period=${period}`}>GSTR-1 &amp; 3B details</LinkButton>
        {edit && <LinkButton href={`/gst/pay?period=${period}`} variant="secondary">Record GST paid</LinkButton>}
        <LinkButton href="/gst/rates" variant="secondary">GST rates</LinkButton>
      </div>
    </Card>

    <Card className="mb-6">
      <h2 className="text-[18px] font-semibold">Items requiring review</h2>
      {review.length === 0 ? <p className="mt-2"><Status tone="good">Nothing to review for this period.</Status></p> :
      <ul className="mt-3 space-y-2">{review.map((x) => <li key={x.what}><Link href={x.href} className="block rounded-xl bg-surface-2 px-4 py-3 hover:ring-1 hover:ring-brand">
        <p className="font-medium">⚠ {x.what}</p><p className="text-[14px] text-ink-2">{x.why}</p></Link></li>)}</ul>}
    </Card>

    <Card>
      <h2 className="text-[18px] font-semibold">Do suppliers&rsquo; filings match your purchases? (GSTR-2B)</h2>
      {rec ? <>
        <p className="mt-2 flex flex-wrap gap-2"><Status tone="good">{rec.counts.matched} matched</Status>{rec.counts.diff > 0 && <Status tone="warn">{rec.counts.diff} amount differs</Status>}
          {rec.counts.notIn2b > 0 && <Status tone="warn">{rec.counts.notIn2b} not filed by supplier yet</Status>}{rec.counts.notInBooks > 0 && <Status tone="info">{rec.counts.notInBooks} not in your books</Status>}</p>
        {rec.riskTax.gt(0) && <p className="mt-2 text-ink-2">{formatINR(rec.riskTax)} of your GST credit is at risk until suppliers file or fix their bills.</p>}
        <p className="mt-3"><Link className="text-brand underline" href={`/gst/2b/${imp!.id}`}>See the match list</Link></p>
      </> : <p className="mt-2 text-ink-2">Not checked for {per.label}. Download GSTR-2B (JSON) from the GST portal and <Link className="text-brand underline" href={`/gst/2b?period=${period}`}>upload it here</Link>.</p>}
    </Card>
  </>;
}
