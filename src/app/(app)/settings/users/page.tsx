import { APP_NAME } from "@/lib/brand";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { ROLE_LABEL, ROLES, type Role } from "@/lib/permissions";
import { Button, Card, Field, Input, Notice, PageHeader, Select } from "@/components/ui";
import { addUserAction } from "../../../actions";
import { resetPasswordAction, toggleUserAction } from "../../../actions-ledger";

export default async function Users({ searchParams }: { searchParams: Promise<{ error?: string; field?: string; added?: string; msg?: string }> }) {
  const ctx = await requireContext("users.manage");
  const sp = await searchParams;
  const rows = await db.select({ id: schema.users.id, active: schema.users.isActive, name: schema.users.name, email: schema.users.email, role: schema.memberships.role, last: schema.users.lastLoginAt })
    .from(schema.memberships).innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(eq(schema.memberships.companyId, ctx.company.id));
  const err = (f: string) => (sp.field === f ? sp.error : undefined);
  return <>
    <PageHeader title="Team & roles" subtitle={`Who can use ${APP_NAME} and what they can do.`} />
    {sp.added && <div className="mb-4"><Notice tone="good" title="Team member added. Share their email and password with them." /></div>}
    {sp.msg && <div className="mb-4"><Notice tone="good" title={sp.msg} /></div>}
    {sp.error && sp.field === undefined && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card className="mb-6">
      <table className="w-full text-left text-[15px]">
        <caption className="sr-only">Team members</caption>
        <thead className="text-[13px] text-ink-3"><tr><th className="pb-2">Name</th><th className="pb-2">Email</th><th className="pb-2">Role</th><th className="pb-2">Last login</th><th className="pb-2">Manage</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.email} className="border-t border-line">
          <td className="py-3">{r.name}</td><td>{r.email}</td><td>{ROLE_LABEL[r.role as Role]}</td>
          <td className="text-ink-2">{r.last ? r.last.toLocaleDateString("en-IN") : "Never"}{!r.active && <span className="ml-2 text-warn">· deactivated</span>}</td>
          <td className="py-2">{r.id !== ctx.user.id && <details><summary className="cursor-pointer text-[14px] text-brand">Options</summary>
            <form action={resetPasswordAction} className="mt-2 flex gap-2"><input type="hidden" name="userId" value={r.id} />
              <Input name="password" placeholder="New password" minLength={8} required autoComplete="off" className="!py-1.5" /><Button variant="secondary" className="!py-1.5">Set</Button></form>
            {r.role !== "OWNER" && <form action={toggleUserAction} className="mt-2"><input type="hidden" name="userId" value={r.id} />
              <input type="hidden" name="active" value={r.active ? "0" : "1"} />
              <button className="text-[14px] text-ink-2 underline">{r.active ? "Deactivate (can no longer log in)" : "Reactivate"}</button></form>}
          </details>}</td></tr>)}</tbody>
      </table>
    </Card>
    <Card>
      <h2 className="mb-4 text-[18px] font-semibold">Add a team member</h2>
      {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
      <form action={addUserAction} className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" error={err("name")}><Input name="name" required /></Field>
        <Field label="Email" error={err("email")}><Input name="email" type="email" required /></Field>
        <Field label="Temporary password" hint="At least 8 characters" error={err("password")}><Input name="password" type="text" minLength={8} required autoComplete="off" /></Field>
        <Field label="Role"><Select name="role" defaultValue="SALESPERSON">
          {ROLES.filter((r) => r !== "OWNER").map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
        <div className="sm:col-span-2"><Button>Add member</Button></div>
      </form>
    </Card>
  </>;
}
