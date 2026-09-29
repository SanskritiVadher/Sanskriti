import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { DEFS, ratioTargets } from "@/lib/analytics/ratios";
import { reorderSettings } from "@/lib/analytics/stock";
import { Button, Card, Field, Input, Notice, PageHeader } from "@/components/ui";
import { saveReorderAction, saveTargetsAction } from "../../../actions-phase7";

export default async function Targets({ searchParams }: { searchParams: Promise<{ error?: string; saved?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const sp = await searchParams;
  const edit = can(ctx.role, "company.edit");
  const [t, s] = await Promise.all([ratioTargets(db, ctx.company.id), reorderSettings(db, ctx.company.id)]);
  const defs = DEFS.filter((d) => d.higherIsBetter != null);
  return <>
    <PageHeader title="My targets" subtitle="Set your own goals. When set, your target is used instead of any general reference." />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Saved." /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card className="mb-6">
      <h2 className="mb-1 text-[18px] font-semibold">Reordering stock</h2>
      <p className="mb-4 text-[14px] text-ink-2">Used for reorder suggestions on the stock insights page.</p>
      <form action={saveReorderAction} className="grid gap-4 sm:grid-cols-2"><fieldset disabled={!edit} className="contents">
        <Field label="Days the supplier takes to deliver" hint="Lead time"><Input name="leadDays" type="number" min={0} max={365} defaultValue={s.leadDays} required /></Field>
        <Field label="Days of stock to order for" hint="How long each order should last"><Input name="coverDays" type="number" min={0} max={365} defaultValue={s.coverDays} required /></Field>
        <Field label="Extra days as a cushion" hint="Safety stock, in days of sales"><Input name="safetyDays" type="number" min={0} max={365} defaultValue={s.safetyDays} required /></Field>
        <Field label="Days of sales history to look at"><Input name="lookbackDays" type="number" min={30} max={365} defaultValue={s.lookbackDays} required /></Field>
        {edit && <div className="sm:col-span-2"><Button>Save reorder settings</Button></div>}
      </fieldset></form>
    </Card>
    <Card>
      <h2 className="mb-1 text-[18px] font-semibold">Ratio targets</h2>
      <p className="mb-4 text-[14px] text-ink-2">Leave blank to compare with your own history. Percentages as numbers (e.g. 12 for 12%).</p>
      <form action={saveTargetsAction} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><fieldset disabled={!edit} className="contents">
        {defs.map((d) => <Field key={d.key} label={d.ownerName} hint={`${d.name} · ${d.unit === "%" ? "%" : d.unit === "days" ? "days" : "times"} · ${d.higherIsBetter ? "higher is better" : "lower is better"}`}>
          <Input name={`t_${d.key}`} type="number" step="any" min={0} defaultValue={t[d.key] ?? ""} /></Field>)}
        {edit && <div className="sm:col-span-full"><Button>Save targets</Button></div>}
      </fieldset></form>
    </Card>
  </>;
}
