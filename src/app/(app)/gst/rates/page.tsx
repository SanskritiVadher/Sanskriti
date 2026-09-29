import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { ruleFor } from "@/lib/services/gst";
import { D } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, PageHeader, Select, Status } from "@/components/ui";
import { addRuleAction, confirmRuleAction, starterRulesAction } from "@/app/actions-phase5";

const ST = { VERIFIED: ["good", "Verified (official source)"], USER_CONFIRMED: ["good", "Checked by you"], SECONDARY_SOURCE: ["warn", "From a secondary source — confirm"], UNVERIFIED: ["bad", "Unverified"] } as const;

export default async function Rates({ searchParams }: { searchParams: Promise<{ saved?: string; applied?: string; error?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const [rules, prods] = await Promise.all([db.query.gstRateRules.findMany({ where: eq(schema.gstRateRules.companyId, ctx.company.id), orderBy: schema.gstRateRules.hsnPrefix }),
    db.query.products.findMany({ where: eq(schema.products.companyId, ctx.company.id) })]);
  const today = todayIST();
  const edit = can(ctx.role, "gst.configure");
  const rows = prods.filter((p) => p.isActive).map((p) => ({ p, rule: ruleFor(rules, p.hsn, today) }));
  return <>
    <PageHeader title="GST rates" subtitle="Where each rate comes from, and whether it's been checked." />
    {sp.saved && <div className="mb-4"><Notice tone="good" title={`Saved.${sp.applied && sp.applied !== "0" ? ` Rate applied to ${sp.applied} product(s).` : ""}`} /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
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

    <Card className="mb-6 overflow-x-auto">
      <h2 className="mb-3 text-[18px] font-semibold">Your products</h2>
      <table className="w-full min-w-[560px] text-[14px]"><caption className="sr-only">Product rates</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Product</th><th className="pb-2">HSN</th><th className="pb-2">Rate on product</th><th className="pb-2">Rate table says</th></tr></thead>
        <tbody>{rows.map(({ p, rule }) => <tr key={p.id} className="border-t border-line">
          <td className="py-2">{p.name}</td><td className="num">{p.hsn ?? <Status tone="warn">missing</Status>}</td>
          <td>{p.gstRate ? `${D(p.gstRate).toString()}%` : "—"} {p.gstRate && (p.gstRateStatus === "USER_CONFIRMED" ? <Status tone="good">confirmed</Status> : <Status tone="warn">not confirmed</Status>)}</td>
          <td>{rule ? (p.gstRate && !D(rule.rate).eq(p.gstRate) ? <Status tone="bad">{D(rule.rate).toString()}% — different!</Status> : `${D(rule.rate).toString()}%`) : <span className="text-ink-3">no rule</span>}</td></tr>)}</tbody></table>
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
