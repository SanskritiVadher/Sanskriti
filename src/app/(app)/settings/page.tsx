import Link from "next/link";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { GST_STATES } from "@/lib/gst/states";
import { Button, Card, Field, Input, Notice, PageHeader, Select } from "@/components/ui";
import { saveBusinessAction, saveGstAction } from "../../actions";

export default async function Settings({ searchParams }: { searchParams: Promise<{ error?: string; field?: string; saved?: string; gstin?: string }> }) {
  const ctx = await requireContext();
  const sp = await searchParams;
  const c = ctx.company;
  const err = (f: string) => (sp.field === f ? sp.error : undefined);
  const edit = can(ctx.role, "company.edit");
  return <>
    <PageHeader title="Settings" subtitle="Business details, GST, team and accounts." />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Saved." /></div>}
    {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <div className="mb-6 flex flex-wrap gap-2">
      {can(ctx.role, "users.manage") && <Link href="/settings/users" className="rounded-lg border border-line bg-surface px-4 py-2">Team & roles</Link>}
      <Link href="/settings/accounts" className="rounded-lg border border-line bg-surface px-4 py-2">Chart of accounts</Link>
      {can(ctx.role, "ledger.post_manual") && <Link href="/settings/opening" className="rounded-lg border border-line bg-surface px-4 py-2">Opening balances</Link>}
      {edit && <Link href="/settings/years" className="rounded-lg border border-line bg-surface px-4 py-2">Financial years</Link>}
      {can(ctx.role, "reports.financial") && <Link href="/settings/health" className="rounded-lg border border-line bg-surface px-4 py-2">System health</Link>}
      {can(ctx.role, "reports.financial") && <Link href="/settings/targets" className="rounded-lg border border-line bg-surface px-4 py-2">My targets</Link>}
      <Link href="/settings/password" className="rounded-lg border border-line bg-surface px-4 py-2">Change my password</Link>
      {can(ctx.role, "ledger.post_manual") && <Link href="/money/new?type=journal" className="rounded-lg border border-line bg-surface px-4 py-2 text-ink-2">Advanced: manual journal</Link>}
      {edit && <Link href="/setup?step=3" className="rounded-lg border border-line bg-surface px-4 py-2">Bank accounts</Link>}
      {edit && <Link href="/setup?step=4" className="rounded-lg border border-line bg-surface px-4 py-2">Brands</Link>}
    </div>
    <Card className="mb-6">
      <h2 className="mb-4 text-[18px] font-semibold">Business details</h2>
      <form action={saveBusinessAction} className="grid gap-4 sm:grid-cols-2">
        <fieldset disabled={!edit} className="contents">
          <Field label="Business name" error={err("name")}><Input name="name" defaultValue={c.name} required /></Field>
          <Field label="Legal name"><Input name="legalName" defaultValue={c.legalName ?? ""} /></Field>
          <Field label="Phone"><Input name="phone" defaultValue={c.phone ?? ""} /></Field>
          <Field label="Email"><Input name="email" type="email" defaultValue={c.email ?? ""} /></Field>
          <Field label="Address"><Input name="addressLine1" defaultValue={c.addressLine1 ?? ""} /></Field>
          <Field label="Address line 2"><Input name="addressLine2" defaultValue={c.addressLine2 ?? ""} /></Field>
          <Field label="City"><Input name="city" defaultValue={c.city ?? ""} /></Field>
          <Field label="PIN code" error={err("pincode")}><Input name="pincode" defaultValue={c.pincode ?? ""} /></Field>
          <Field label="State"><Select name="stateCode" defaultValue={c.stateCode ?? ""}>
            {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select></Field>
          {edit && <div className="sm:col-span-2"><Button>Save</Button></div>}
        </fieldset>
      </form>
    </Card>
    {can(ctx.role, "gst.configure") && <Card>
      <h2 className="mb-4 text-[18px] font-semibold">GST</h2>
      <form action={saveGstAction} className="grid gap-4 sm:grid-cols-2">
        <Field label="Registration"><Select name="registration" defaultValue={c.gstRegistration}>
          <option value="REGULAR">Regular</option><option value="COMPOSITION">Composition</option><option value="UNREGISTERED">Not registered</option></Select></Field>
        <Field label="GSTIN" error={err("gstin")}><Input name="gstin" defaultValue={sp.gstin ?? c.gstin ?? ""} maxLength={15} className="uppercase" /></Field>
        <div className="sm:col-span-2"><Button>Save GST details</Button></div>
      </form>
    </Card>}
  </>;
}
