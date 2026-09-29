import Link from "next/link";
import { loginAction } from "../actions";
import { AuthShell } from "../auth-shell";
import { Button, Field, Input, Notice } from "@/components/ui";

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; restored?: string; warn?: string }> }) {
  const { error, restored, warn } = await searchParams;
  return <AuthShell title="Welcome back" subtitle="Log in to see how your business is doing.">
    <form action={loginAction} className="space-y-4">
      {error && <Notice tone="bad" title={error} />}
      {restored && <Notice tone={warn ? "warn" : "good"} title={warn ?? "Backup restored and checked. Log in with your usual email and password."} />}
      <Field label="Email"><Input name="email" type="email" autoComplete="email" required /></Field>
      <Field label="Password"><Input name="password" type="password" autoComplete="current-password" required /></Field>
      <Button className="w-full">Log in</Button>
      <p className="text-center text-[14px] text-ink-2">New here? <Link className="text-brand underline" href="/signup">Create your business account</Link></p>
    </form>
  </AuthShell>;
}
