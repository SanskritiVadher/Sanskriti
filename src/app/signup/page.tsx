import Link from "next/link";
import { db } from "@/db";
import { signupOpen } from "@/lib/services/company";
import { signupAction, restoreBackupAction } from "../actions";
import { AuthShell } from "../auth-shell";
import { Button, Field, Input, Notice } from "@/components/ui";

export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string; field?: string }> }) {
  const { error, field } = await searchParams;
  if (!(await signupOpen(db))) return <AuthShell title="Sign-ups are closed" subtitle="This app already has an owner.">
    <p className="text-[15px]">Ask the owner to add you under Settings → Team &amp; roles. They&rsquo;ll give you your email and password.</p>
    <p className="mt-4 text-center text-[14px]"><Link className="text-brand underline" href="/login">Log in</Link></p></AuthShell>;
  return <AuthShell title="Set up your business" subtitle="Takes about 5 minutes. You can skip anything and finish later.">
    <form action={signupAction} className="space-y-4">
      {error && !field && <Notice tone="bad" title={error} />}
      <Field label="Your name"><Input name="name" required autoComplete="name" /></Field>
      <Field label="Business name" hint="e.g. Sharma Battery House"><Input name="businessName" required /></Field>
      <Field label="Email" error={field === "email" ? error : undefined}><Input name="email" type="email" required autoComplete="email" /></Field>
      <Field label="Password" hint="At least 8 characters" error={field === "password" ? error : undefined}>
        <Input name="password" type="password" minLength={8} required autoComplete="new-password" /></Field>
      <Button className="w-full">Create account</Button>
      <p className="text-center text-[14px] text-ink-2">Already have an account? <Link className="text-brand underline" href="/login">Log in</Link></p>
    </form>
    <form action={restoreBackupAction} className="mt-6 flex flex-col gap-2 border-t border-line pt-4 text-[14px]">
      <p className="font-medium">Moving to a new database, or recovering after data loss?</p>
      <p className="text-ink-2">Restore your Sanskriti backup file (.json.gz) instead of creating a new account. Files over 4 MB can&rsquo;t be uploaded here — use the restore script described in the README.</p>
      <input type="file" name="backup" accept=".gz,.json" aria-label="Backup file" className="text-[14px]" />
      <Button variant="secondary">Restore backup</Button>
    </form>
  </AuthShell>;
}
