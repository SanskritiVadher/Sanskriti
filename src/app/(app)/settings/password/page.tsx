import { requireContext } from "@/lib/session";
import { Button, Card, Field, Input, Notice, PageHeader } from "@/components/ui";
import { changePasswordAction } from "../../../actions-ledger";

export default async function Password({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string; field?: string }> }) {
  await requireContext();
  const sp = await searchParams;
  const err = (f: string) => (sp.field === f ? sp.error : undefined);
  return <>
    <PageHeader title="Change my password" />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Password changed." /></div>}
    {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card className="max-w-md"><form action={changePasswordAction} className="space-y-4">
      <Field label="Current password" error={err("current")}><Input type="password" name="current" required autoComplete="current-password" /></Field>
      <Field label="New password" hint="At least 8 characters" error={err("password")}><Input type="password" name="password" minLength={8} required autoComplete="new-password" /></Field>
      <Field label="Type new password again" error={err("confirm")}><Input type="password" name="confirm" required autoComplete="new-password" /></Field>
      <Button>Change password</Button>
    </form></Card>
  </>;
}
