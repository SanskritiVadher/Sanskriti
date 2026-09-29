import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { ruleFor, rateProblems, gstStrict, trustedRule } from "@/lib/services/gst";
import { D } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, PageHeader, Select, Status } from "@/components/ui";
import { addRuleAction, confirmRuleAction, starterRulesAction, gstStrictAction, confirmProductRatesAction } from "@/app/actions-phase5";

const ST = { VERIFIED: ["good", "Verified (official source)"], USER_CONFIRMED: ["good", "Checked by you"], SECONDARY_SOURCE: ["warn", "From a secondary source — confirm"], UNVERIFIED: ["bad", "Unverified"] } as const;

export default async function Rates({ searchParams }: { searchParams: Promise<{ saved?: string; applied?: string; error?: string; confirmed?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const [rules, prods] = await Promise.all([db.query.gstRateRules.findMany({ where: eq(schema.gstRateRules.companyId, ctx.company.id), orderBy: schema.gstRateRules.hsnPrefix }),
    db.query.products.findMany({ where: eq(schema.products.companyId, ctx.company.id) })]);
  const today = todayIST();
  const edit = can(ctx.role, "gst.configure");
  const rows = prods.filter((p) => p.isActive).map((p) => ({ p, rule: ruleFor(rules, p.hsn, today) }))
    .sort((a, b) => Number(a.p.gstRateStatus === "USER_CONFIRMED") - Number(b.p.gstRateStatus === "USER_CONFIRMED") || a.p.name.localeCompare(b.p.name));
  const [probs, strict] = await Promise.all([rateProblems(db, ctx.company.id, today), gstStrict(db, ctx.company.id)]);
  const conflictIds = new Set(probs.hsnConflicts.flatMap((c) => c.rates.flatMap((r) => r.products.map((p) => p.id))));
  const blocking = probs.unconfirmed.length + probs.ruleMismatch.length + probs.noRate.length;
  return <>
    <PageHeader title="GST rates" subtitle="Where each rate comes from, and whether it's been checked." />
    {sp.saved && <div className="mb-4"><Notice tone="good" title={`Saved.${sp.applied && sp.applied !== "0" ? ` Rate applied to ${sp.applied} product(s).` : ""}`} /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    {sp.confirmed && <div className="mb-4"><Notice tone="good" title={`${sp.confirmed} product rate${sp.confirmed === "1" ? "" : "s"} confirmed.`} /></div>}

    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="max-w-2xl">
        <h2 className="text-[18px] font-semibold">Only bill checked rates</h2>
        <p className="mt-1 text-[14px] text-ink-2">{strict.on
          ? <>On since {fmtDate(strict.since!)}. A sale is refused if any product&rsquo;s rate isn&rsquo;t confirmed, or doesn&rsquo;t match your checked rate table.</>
          : <>Off. Unchecked rates only show a warning when billing. Turn this on once your products are checked, so staff can&rsquo;t bill at a wrong rate.</>}</p>
        {!strict.on && blocking > 0 && <p className="mt-1 text-[14px] text-warn">{blocking} product{blocking > 1 ? "s" : ""} would be blocked right now: {probs.unconfirmed.length} not confirmed{probs.ruleMismatch.length ? `, ${probs.ruleMismatch.length} different from the rate table` : ""}{probs.noRate.length ? `, ${probs.noRate.length} with no rate` : ""}.</p>}
      </div>
      {edit && <form action={gstStrictAction}><input type="hidden" name="on" value={strict.on ? "0" : "1"} /><Button variant={strict.on ? "secondary" : "primary"}>{strict.on ? "Turn off" : "Turn on"}</Button></form>}</div>
    </Card>

    {probs.hsnConflicts.length > 0 && <Card className="mb-6"><h2 className="text-[18px] font-semibold">Same HSN, different rates</h2>
      <p className="mt-1 text-[14px] text-ink-2">One HSN code normally has one rate. At least one product in each group below is wrong.</p>
      <ul className="mt-3 space-y-2 text-[14px]">{probs.hsnConflicts.map((c) => <li key={c.hsn}><b className="num">HSN {c.hsn}:</b> {c.rates.map((r) => <span key={r.rate} className="mr-3">{r.rate}% — {r.products.map((p) => p.name).join(", ")}</span>)}</li>)}</ul></Card>}
    <Notice tone="info" title="The app never changes a GST rate on its own.">There is no official live feed of GST rates. Rates here come from you, or from sources we researched,
      and each shows where it came from. A rate is used on bills only after you confirm it.</Notice>

    <Card className="my-6 overflow-x-auto">
      <h2 className="mb-3 text-[18px] font-semibold">Your rate table</h2>
      {rules.length === 0 ? <div className="text-ink-2"><p>No rates yet.</p>
        {edit && <form action={starterRulesAction} className="mt-3"><Button variant="secondary">Add researched rate for batteries (HSN 8507)</Button>
          <p className="mt-1 text-[13px] text-ink-3">Added as &ldquo;secondary source&rdquo;. Check it against your supplier&rsquo;s GST bill for a battery, then confirm.</p></form>}</div> :
      <table className="w-full min-w-[720px] text-[14px]"><caption className="sr-only">Rates</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">HSN</th><th className="pb-2">Description</th><th className="pb-2">Rate</th><th className="pb-2">From</th><th className="pb-2">Status &amp; source</th>{edit && <th className="pb-2">Confirm</th>}</tr></thead>
        <tbody>{rules.map((r) => <tr key={r.id} className="border-t border-line align-top">
          <td className="num py-2">{r.hsnPrefix}</td><td>{r.description}{r.notes && <span className="block text-[12px] text-ink-3">{r.notes}</span>}</td>
          <td className="num">{D(r.rate).toString()}%</td><td className="whitespace-nowrap">{fmtDate(r.effectiveFrom)}</td>
          <td><Status tone={ST[r.status][0]}>{ST[r.status][1]}</Status>{r.sourceName && <span className="block text-[12px] text-ink-3">{r.sourceUrl ? <a className="underline" href={r.sourceUrl} target="_blank" rel="noopener noreferrer">{r.sourceName}</a> : r.sourceName}{r.retrievedOn && ` · checked ${fmtDate(r.retrievedOn)}`}</span>}</td>
          {edit && <td>{r.status !== "VERIFIED" && r.status !== "USER_CONFIRMED" ? <form action={confirmRuleAction} className="space-y-1">
            <input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value="USER_CONFIRMED" />
            <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" name="apply" value="1" defaultChecked /> also set on matching products</label>
            <Button variant="secondary" className="!px-3 !py-1.5 text-[13px]">I&rsquo;ve checked this rate</Button></form>
            : <form action={confirmRuleAction}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value={r.status} /><input type="hidden" name="apply" value="1" />
              <button className="text-[13px] text-brand underline">Apply to matching products</button></form>}</td>}
        </tr>)}</tbody></table>}
    </Card>

    <Card className="mb-6 overflow-x-auto"><section id="products">
      <h2 className="mb-1 text-[18px] font-semibold">Your products</h2>
      <p className="mb-3 text-[14px] text-ink-2">Take one recent bill from each supplier. Tick the products whose HSN and rate match that bill, write the bill number, and confirm.</p>
      <form action={confirmProductRatesAction}>
      <table className="w-full min-w-[640px] text-[14px]"><caption className="sr-only">Product rates</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr>{edit && <th className="w-8 pb-2" />}<th className="pb-2">Product</th><th className="pb-2">HSN</th><th className="pb-2">Rate on product</th><th className="pb-2">Rate table says</th></tr></thead>
        <tbody>{rows.map(({ p, rule }) => { const trusted = trustedRule(rule); const diff = !!(rule && p.gstRate && !D(rule.rate).eq(p.gstRate));
          const canTick = edit && p.gstRate != null && p.gstRateStatus !== "USER_CONFIRMED" && !(trusted && diff); return <tr key={p.id} className="border-t border-line">
          {edit && <td className="py-2">{canTick && <input type="checkbox" name="pid" value={p.id} aria-label={`Confirm ${p.name}`} />}</td>}
          <td className="py-2"><Link className="hover:underline" href={`/inventory/${p.id}/edit`}>{p.name}</Link>{conflictIds.has(p.id) && <span className="ml-2 text-[12px] text-bad">HSN clash</span>}</td>
          <td className="num">{p.hsn ?? <Status tone="warn">missing</Status>}</td>
          <td>{p.gstRate ? `${D(p.gstRate).toString()}%` : "—"} {p.gstRate && (p.gstRateStatus === "USER_CONFIRMED" ? <Status tone="good">confirmed</Status> : <Status tone="warn">not confirmed</Status>)}</td>
          <td>{rule ? (diff ? <Status tone="bad">{D(rule.rate).toString()}% — different{trusted ? "" : " (table rate not checked)"}</Status> : `${D(rule.rate).toString()}%`) : <span className="text-ink-3">no rule</span>}</td></tr>; })}</tbody></table>
      {edit && probs.unconfirmed.length > 0 && <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Checked against (bill number)"><Input name="checkedAgainst" placeholder="e.g. SF Sonic bill 1234" required maxLength={120} /></Field>
        <Button>Confirm ticked rates</Button></div>}
      </form></section>
    </Card>

    {edit && <Card><h2 className="mb-3 text-[18px] font-semibold">Add a rate</h2>
      <form action={addRuleAction} className="grid gap-3 sm:grid-cols-3">
        <Field label="HSN (2–8 digits)"><Input name="hsn" required inputMode="numeric" /></Field>
        <Field label="Rate %"><Input name="rate" required inputMode="decimal" /></Field>
        <Field label="Effective from"><Input type="date" name="from" defaultValue="2025-09-22" required /></Field>
        <Field label="Description"><Input name="description" /></Field>
        <Field label="Where you checked it (e.g. SF bill no. 101)"><Input name="sourceName" /></Field>
        <Field label="Source link (official notification for 'verified')"><Input name="sourceUrl" type="url" /></Field>
        <Field label="Status"><Select name="status" defaultValue="USER_CONFIRMED"><option value="USER_CONFIRMED">I checked it</option><option value="VERIFIED">Verified from official notification</option><option value="SECONDARY_SOURCE">From a website / other source</option><option value="UNVERIFIED">Not sure</option></Select></Field>
        <div className="sm:col-span-2"><Field label="Note"><Input name="notes" /></Field></div>
        <div className="sm:col-span-3"><Button>Add rate</Button></div>
      </form></Card>}
  </>;
}
