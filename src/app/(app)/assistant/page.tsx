import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { todayIST, fmtDate } from "@/lib/dates";
import { formatINR, D } from "@/lib/money";
import { parseQuickEntry, type Kind } from "@/lib/assist/quick-entry";
import { quickEntryContext } from "@/lib/assist/context";
import { partyBalances } from "@/lib/services/parties";
import { findings } from "@/lib/analytics/anomalies";
import { AccountSelect } from "@/components/accounts-select";
import { Button, Card, Field, Input, Notice, PageHeader, Select } from "@/components/ui";
import { confirmQuickEntryAction } from "../../actions-phase8";

const KINDS: [Kind, string][] = [["CUSTOMER_PAYMENT", "Customer paid me"], ["SUPPLIER_PAYMENT", "I paid a supplier"], ["EXPENSE", "Expense"],
  ["DRAWINGS", "Took money for home"], ["MONEY_IN", "Other money in"], ["DEPOSIT", "Cash to bank"], ["WITHDRAW", "Bank to cash"]];
const EXAMPLES = ["Ramesh paid 5000 cash", "paid 25,000 to SF Sonic by NEFT", "chai 200 cash", "rent 12k bank", "deposited 20000 cash in bank", "sahu se 1.5 lakh mila upi kal"];

export default async function Assistant({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string; error?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const canRecord = can(ctx.role, "money.record");
  const q = (sp.q ?? "").slice(0, 300);
  const c = canRecord && q ? await quickEntryContext(ctx.company.id) : null;
  const p = c ? parseQuickEntry(q, { parties: c.parties, accounts: c.accounts, today: todayIST() }) : null;
  const kind = (KINDS.some(([k]) => k === sp.kind) ? sp.kind : p?.kind) as Kind | null;
  const open = can(ctx.role, "reports.financial") ? (await findings(db, ctx.company.id)).open : null;

  let preview: string | null = null;
  if (p && c && kind && p.partyId && p.amount && (kind === "CUSTOMER_PAYMENT" || kind === "SUPPLIER_PAYMENT")) {
    const t = kind === "CUSTOMER_PAYMENT" ? "CUSTOMER" : "SUPPLIER";
    const bal = (await partyBalances(db, ctx.company.id, t)).get(p.partyId)?.balance ?? D(0);
    const name = c.parties.find((x) => x.id === p.partyId)!.name;
    preview = `${name} ${t === "CUSTOMER" ? "owes you" : "is owed"} ${formatINR(bal)} now → ${formatINR(D(bal).minus(p.amount))} after this.`;
  }
  const cashId = c?.cashBank.find((a) => a.systemKey === "CASH")?.id, bankId = c?.cashBank.find((a) => a.groupCode === "1120")?.id;
  const cbDefault = p?.mode === "CASH" ? cashId : p?.mode === "BANK" ? bankId : undefined;
  const partyList = c && kind ? c.parties.filter((x) => x.type === (kind === "CUSTOMER_PAYMENT" ? "CUSTOMER" : "SUPPLIER")) : [];
  const partyDefault = p?.partyId;
  const withKind = (k: string) => `/assistant?q=${encodeURIComponent(q)}&kind=${k}`;

  return <>
    <PageHeader title="Assistant" subtitle="Type what happened; check it; save. Nothing is saved until you confirm." />
    {canRecord && <Card className="mb-6">
      <h2 className="text-[18px] font-semibold">Quick entry</h2>
      <form method="get" className="mt-3 flex flex-col gap-2 sm:flex-row">
        <Input name="q" defaultValue={q} placeholder="e.g. Ramesh paid 5000 cash" aria-label="What happened?" className="flex-1" autoFocus={!q} maxLength={300} />
        <Button>Read it</Button>
      </form>
      {!q && <p className="mt-3 text-[13px] text-ink-3">Try: {EXAMPLES.map((e, i) => <span key={e}>{i ? " · " : ""}<Link className="underline" href={`/assistant?q=${encodeURIComponent(e)}`}>{e}</Link></span>)}</p>}
      <p className="mt-2 text-[13px] text-ink-3">Handles money in/out, customer and supplier payments, expenses, and cash ↔ bank. Sales and purchase bills have their own screens (Sell, Buy).</p>
    </Card>}

    {p && c && <Card className="mb-6">
      <h2 className="text-[18px] font-semibold">Check this before saving</h2>
      <p className="mt-1 text-[14px] text-ink-2">You typed: &ldquo;{q}&rdquo;</p>
      {sp.error && <div className="mt-3"><Notice tone="bad" title={sp.error} /></div>}
      {p.unclear.length > 0 && <div className="mt-3"><Notice tone="warn" title="I couldn't tell:"><ul className="list-disc pl-5">{p.unclear.map((u) => <li key={u}>{u}</li>)}</ul></Notice></div>}
      {p.assumed.length > 0 && <p className="mt-3 text-[14px] text-ink-2">Assumed: {p.assumed.join(" ")}</p>}
      <div className="mt-4 flex flex-wrap gap-2 text-[14px]">{KINDS.map(([k, l]) => <Link key={k} href={withKind(k)}
        className={`rounded-full px-3 py-1 ${k === kind ? "bg-brand text-brand-ink" : "bg-surface-2 text-ink-2"}`}>{l}</Link>)}</div>
      {kind && <form action={confirmQuickEntryAction} className="mt-4 grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="kind" value={kind} /><input type="hidden" name="text" value={q} />
        <Field label="Amount (₹)"><Input name="amount" inputMode="decimal" defaultValue={p.amount ?? ""} required className="num" /></Field>
        <Field label="Date" hint={p.date !== todayIST() ? fmtDate(p.date) : undefined}><Input type="date" name="date" defaultValue={p.date} required /></Field>
        {(kind === "CUSTOMER_PAYMENT" || kind === "SUPPLIER_PAYMENT") && <Field label={kind === "CUSTOMER_PAYMENT" ? "Customer" : "Supplier"}>
          <Select name="partyId" defaultValue={partyDefault ?? ""} required><option value="">Choose…</option>
            {p.partyCandidates.length > 1 && <optgroup label="Did you mean">{p.partyCandidates.map((x) => <option key={"c" + x.id} value={x.id}>{x.name}</option>)}</optgroup>}
            <optgroup label="All">{partyList.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup></Select></Field>}
        {(kind === "EXPENSE" || kind === "DRAWINGS") && <Field label="Paid for"><AccountSelect name="otherId" options={c.expenseOpts} defaultValue={p.kind === kind ? p.accountId ?? undefined : kind === "DRAWINGS" ? c.accounts.find((a) => a.systemKey === "DRAWINGS")?.id : undefined} /></Field>}
        {kind === "MONEY_IN" && <Field label="Received from / for"><AccountSelect name="otherId" options={c.incomeOpts} defaultValue={p.kind === kind ? p.accountId ?? undefined : undefined} /></Field>}
        {kind === "DEPOSIT" || kind === "WITHDRAW" ? <>
          <Field label="From"><AccountSelect name="fromId" options={c.cashBank} defaultValue={kind === "DEPOSIT" ? cashId : bankId} /></Field>
          <Field label="To"><AccountSelect name="toId" options={c.cashBank} defaultValue={kind === "DEPOSIT" ? bankId : cashId} /></Field>
        </> : <Field label={kind === "CUSTOMER_PAYMENT" || kind === "MONEY_IN" ? "Received into" : "Paid from"}><AccountSelect name="cashBankId" options={c.cashBank} defaultValue={cbDefault} /></Field>}
        <div className="sm:col-span-2"><Field label="Note"><Input name="narration" defaultValue={q} /></Field></div>
        {preview && <p className="sm:col-span-2 text-[14px]">{preview}</p>}
        <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" name="confirm" value="1" required /> I&rsquo;ve checked this</label>
        <div className="flex gap-3 sm:col-span-2"><Button>Save entry</Button><Link href="/assistant" className="py-2.5 text-ink-2">Discard</Link></div>
      </form>}
      {!kind && <p className="mt-4 text-[14px]">Choose what kind of entry this is above.</p>}
    </Card>}

    {open && <Card className="mb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-[18px] font-semibold">Things that look unusual</h2><Link className="text-[14px] text-brand underline" href="/assistant/checks">See all</Link></div>
      {open.length === 0 ? <p className="mt-2 text-[14px] text-ink-2">Nothing unusual in the last 90 days.</p> :
        <ul className="mt-3 space-y-2">{open.slice(0, 4).map((f) => <li key={f.key}><Link href={f.href} className="block rounded-xl bg-surface-2 px-4 py-2.5 hover:ring-1 hover:ring-brand">
          <span className={f.tone === "bad" ? "text-bad" : f.tone === "warn" ? "text-warn" : "text-info"} aria-hidden>{f.tone === "info" ? "ℹ " : "⚠ "}</span>{f.what}</Link></li>)}</ul>}
    </Card>}

    <Card><h2 className="text-[18px] font-semibold">Ask in plain words</h2>
      <Notice tone="info" title="Not switched on.">Answering free-form questions and reading photos of bills needs an AI service key, which isn&rsquo;t set up. Everything on this page works without it. Until then: <Link className="underline" href="/reports/health">How is my business doing?</Link> · <Link className="underline" href="/customers">Who owes me?</Link> · <Link className="underline" href="/inventory/insights">What should I reorder?</Link></Notice></Card>
  </>;
}
