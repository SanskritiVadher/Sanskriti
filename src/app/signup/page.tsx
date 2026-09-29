import Link from "next/link";
import { signupAction } from "../actions";
import { AuthShell } from "../auth-shell";
import { Button, Field, Input, Notice } from "@/components/ui";

export default async function Signup({ searchParams }: { searchParams: Promise<{ error?: string; field?: string }> }) {
  const { error, field } = await searchParams;
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
  </AuthShell>;
}
