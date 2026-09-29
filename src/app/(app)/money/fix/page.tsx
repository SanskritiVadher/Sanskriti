import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { correctionOptions } from "@/lib/services/corrections";
import { todayIST } from "@/lib/dates";
import { AccountSelect } from "@/components/accounts-select";
import { Button, Card, Field, Input, Notice, PageHeader } from "@/components/ui";
import { correctionAction } from "@/app/actions-phase3";

const KINDS = {
  category: { q: "I put an expense or income in the wrong category", help: "Moves the amount to the right category. The original entry stays as it was." },
  unpaid: { q: "I have a bill I haven't paid yet", help: "Records the expense now. When you pay, use Money out → Paid for: \"Expenses not yet paid\"." },
  drawings: { q: "I took money from the business for personal / home use", help: "Recorded as money taken out by the owner, not as a business expense." },
  capital: { q: "I put my own money into the business", help: "Recorded as owner's capital, not as income." },
  depreciation: { q: "My vehicle or equipment has lost value (yearly)", help: "Usually done once a year. Take the amount from your CA; the app does not guess rates." },
} as const;

export default async function Fix({ searchParams }: { searchParams: Promise<{ kind?: string; error?: string; field?: string; amount?: string; note?: string }> }) {
  const ctx = await requireContext("money.record");
  const sp = await searchParams;
  const kind = sp.kind && sp.kind in KINDS ? (sp.kind as keyof typeof KINDS) : null;
  const o = await correctionOptions(db, ctx.company.id);
  const err = (f: string) => (sp.field === f ? sp.error : undefined);

  return <>
    <PageHeader title="Fix a mistake or record something unusual" subtitle="Pick what happened. The app records it correctly for you." />
    {!kind ? <div className="grid gap-3">
      {Object.entries(KINDS).map(([k, v]) => <Link key={k} href={`/money/fix?kind=${k}`}><Card className="!p-4 hover:border-brand"><p className="font-medium">{v.q}</p><p className="text-[14px] text-ink-2">{v.help}</p></Card></Link>)}
      <Card className="!p-4"><p className="font-medium">An entry itself is wrong (wrong amount, entered twice)</p>
        <p className="text-[14px] text-ink-2">Open the entry from <Link className="text-brand underline" href="/reports/day-book">Everything recorded</Link> and press &ldquo;Cancel this entry&rdquo;, then enter it again correctly.</p></Card>
    </div> : <Card>
      <h2 className="text-[18px] font-semibold">{KINDS[kind].q}</h2>
      <p className="mb-5 text-[14px] text-ink-2">{KINDS[kind].help}</p>
      {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
      <form action={correctionAction} className="grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="kind" value={kind} />
        {kind === "category" && <>
          <Field label="It was recorded under" error={err("fromId")}><AccountSelect name="fromId" options={[...o.expenses, ...o.income]} /></Field>
          <Field label="It should be under" error={err("toId")}><AccountSelect name="toId" options={[...o.expenses, ...o.income]} /></Field></>}
        {kind === "unpaid" && <Field label="What is the bill for" error={err("expenseId")}><AccountSelect name="expenseId" options={o.expenses} /></Field>}
        {(kind === "drawings" || kind === "capital") && <Field label={kind === "drawings" ? "Taken from" : "Put into"} error={err("cashBankId")}><AccountSelect name="cashBankId" options={o.cashBank} defaultValue={o.cashBank[0]?.id} /></Field>}
        {kind === "depreciation" && <Field label="Which asset" error={err("assetId")}><AccountSelect name="assetId" options={o.fixed} /></Field>}
        <Field label="Amount (₹)" error={err("amount")}><Input name="amount" inputMode="decimal" required defaultValue={sp.amount} className="num" /></Field>
        <Field label="Date"><Input type="date" name="date" defaultValue={todayIST()} required /></Field>
        <Field label="Note (optional)"><Input name="note" defaultValue={sp.note} /></Field>
        <div className="flex gap-3 sm:col-span-2"><Button>Save</Button><Link href="/money/fix" className="py-2.5 text-ink-2">Back</Link></div>
      </form>
      {kind === "drawings" && <p className="mt-4 text-[13px] text-ink-3">Took <i>stock</i> home instead of money? Open the product in Inventory → Correct the stock → &ldquo;Taken for personal / home use&rdquo;.</p>}
    </Card>}
  </>;
}
