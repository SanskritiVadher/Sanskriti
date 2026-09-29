import Link from "next/link";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { accountOptions } from "@/lib/accounting/options";
import { getViewMode } from "@/lib/view-mode";
import { todayIST } from "@/lib/dates";
import { AccountSelect } from "@/components/accounts-select";
import { Button, Card, Field, Input, Notice, PageHeader } from "@/components/ui";
import { recordMoneyAction } from "../../../actions-ledger";

const COPY = {
  receipt: { title: "Money in", sub: "Money received into cash or bank — e.g. capital put in, a loan received, other income." },
  payment: { title: "Money out", sub: "Money paid from cash or bank — e.g. rent, salaries, electricity, owner's drawings." },
  contra: { title: "Move money between cash and bank", sub: "Cash deposited in bank, cash withdrawn, or a transfer between your own accounts." },
  journal: { title: "Adjustment entry", sub: "For accountants: any balanced entry. Total debits must equal total credits." },
} as const;

type SP = { type?: string; error?: string; field?: string; amount?: string; narration?: string; date?: string };

export default async function NewEntry({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const type = (["receipt", "payment", "contra", "journal"].includes(sp.type ?? "") ? sp.type : "receipt") as keyof typeof COPY;
  const ctx = await requireContext(type === "journal" ? "ledger.post_manual" : "money.record");
  const accountant = (await getViewMode()) === "accountant" || type === "journal";
  const opts = await accountOptions(ctx.company.id, accountant);
  const cashBank = opts.filter((o) => o.groupCode === "1110" || o.groupCode === "1120");
  const others = opts.filter((o) => !(o.groupCode === "1110" || o.groupCode === "1120"));
  // Sensible, short lists for owners; full list for accountants.
  const receiptFrom = others.filter((o) => ["INCOME", "EQUITY", "LIABILITY"].includes(o.nature) || o.systemKey === "SUPPLIER_ADVANCES");
  const paymentTo = others.filter((o) => ["EXPENSE", "ASSET", "LIABILITY"].includes(o.nature) || o.systemKey === "DRAWINGS");
  const c = COPY[type];
  const err = (f: string) => (sp.field === f ? sp.error : undefined);

  return <>
    <PageHeader title={c.title} subtitle={c.sub} />
    <div className="mb-6 flex flex-wrap gap-2 text-[14px]">
      {(["receipt", "payment", "contra"] as const).map((t) => <Link key={t} href={`/money/new?type=${t}`}
        className={`rounded-full px-3 py-1 ${t === type ? "bg-brand text-brand-ink" : "bg-surface-2 text-ink-2"}`}>{COPY[t].title.split(" between")[0]}</Link>)}
      {can(ctx.role, "ledger.post_manual") && <Link href="/money/new?type=journal"
        className={`rounded-full px-3 py-1 ${type === "journal" ? "bg-brand text-brand-ink" : "bg-surface-2 text-ink-2"}`}>Adjustment</Link>}
    </div>
    {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card>
      <form action={recordMoneyAction} className="grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="type" value={type} />
        <Field label="Date"><Input type="date" name="date" defaultValue={sp.date || todayIST()} required /></Field>
        {type !== "journal" && <Field label="Amount (₹)" error={err("amount")}>
          <Input name="amount" inputMode="decimal" defaultValue={sp.amount} placeholder="e.g. 25000" required className="num" /></Field>}

        {type === "receipt" && <>
          <Field label="Received into" error={err("cashBankId")}><AccountSelect name="cashBankId" options={cashBank} defaultValue={cashBank[0]?.id} /></Field>
          <Field label="Received from / for" hint="Customer payments come with billing (Phase 4)." error={err("fromAccountId")}>
            <AccountSelect name="otherId" options={receiptFrom} /></Field>
        </>}
        {type === "payment" && <>
          <Field label="Paid from" error={err("cashBankId")}><AccountSelect name="cashBankId" options={cashBank} defaultValue={cashBank[0]?.id} /></Field>
          <Field label="Paid for" hint="Supplier payments come with purchases (Phase 4)." error={err("toAccountId")}>
            <AccountSelect name="otherId" options={paymentTo} /></Field>
        </>}
        {type === "contra" && <>
          <Field label="From" error={err("fromId")}><AccountSelect name="fromId" options={cashBank} defaultValue={cashBank[0]?.id} /></Field>
          <Field label="To" error={err("toId")}><AccountSelect name="toId" options={cashBank} defaultValue={cashBank[1]?.id} /></Field>
        </>}

        {type === "journal" && <div className="sm:col-span-2">
          <table className="w-full text-[15px]">
            <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Account</th><th className="w-36 pb-2">Debit (₹)</th><th className="w-36 pb-2">Credit (₹)</th></tr></thead>
            <tbody>{Array.from({ length: 6 }, (_, i) => <tr key={i}>
              <td className="py-1 pr-2"><AccountSelect name={`acc${i}`} options={opts} showCodes required={i < 2} placeholder="—" /></td>
              <td className="py-1 pr-2"><Input name={`dr${i}`} inputMode="decimal" className="num" aria-label={`Debit line ${i + 1}`} /></td>
              <td className="py-1"><Input name={`cr${i}`} inputMode="decimal" className="num" aria-label={`Credit line ${i + 1}`} /></td></tr>)}</tbody>
          </table>
          <p className="mt-2 text-[13px] text-ink-3">If debits and credits don&rsquo;t match exactly, nothing is saved and you&rsquo;ll see the difference.</p>
        </div>}

        <div className="sm:col-span-2"><Field label="Note (optional)" hint="e.g. September rent, cheque no. 1234">
          <Input name="narration" defaultValue={sp.narration} /></Field></div>
        <div className="flex gap-3 sm:col-span-2"><Button>Save</Button><Link href="/money" className="py-2.5 text-ink-2">Cancel</Link></div>
      </form>
    </Card>
  </>;
}
