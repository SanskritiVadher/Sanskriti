import Link from "next/link";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { fmtDate } from "@/lib/dates";
import { bankAccountsFor } from "@/lib/bank/reconcile";
import { Button, Card, Field, LinkButton, Notice, PageHeader, Select } from "@/components/ui";
import { uploadStatementAction } from "../../../actions-phase9";

export default async function Bank({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireContext("money.record");
  const sp = await searchParams;
  const accs = await bankAccountsFor(db, ctx.company.id);
  const st = await db.execute<{ account_id: string; last: string; n: number; open: number }>(sql`
    SELECT s.account_id, max(s.to_date) last, count(DISTINCT s.id)::int n,
      (SELECT count(*)::int FROM bank_statement_lines b WHERE b.account_id = s.account_id AND b.status = 'UNMATCHED') open
    FROM bank_statements s WHERE s.company_id = ${ctx.company.id} GROUP BY s.account_id`);
  const by = new Map(st.rows.map((r) => [r.account_id, r]));
  return <>
    <PageHeader title="Bank statements" subtitle="Check your books against what the bank actually shows." />
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    {!accs.length ? <Card><Notice tone="info" title="No bank account added yet."><Link className="underline" href="/setup?step=3">Add a bank account</Link> first.</Notice></Card> : <>
      <Card className="mb-6">
        <h2 className="text-[18px] font-semibold">Upload a statement</h2>
        <p className="mt-1 text-[14px] text-ink-2">From net banking, download the account statement as <b>CSV</b> or <b>Excel</b> for any period. Uploading overlapping periods is fine — lines already uploaded are skipped.</p>
        <form action={uploadStatementAction} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field label="Bank account"><Select name="accountId" required>{accs.map((a) => <option key={a.id} value={a.id}>{a.label}{a.last4 ? ` ··${a.last4}` : ""}</option>)}</Select></Field>
          <Field label="Statement file" hint=".csv, .xlsx or .xls (as downloaded)"><input type="file" name="file" accept=".csv,.xlsx,.xls,.txt" required className="block w-full text-[14px]" /></Field>
          <label className="flex items-center gap-2 text-[14px] text-ink-2 sm:col-span-2"><input type="checkbox" name="anyway" value="1" /> Import anyway if the running balance doesn&rsquo;t add up</label>
          <div className="sm:col-span-2"><Button>Upload and check</Button></div>
        </form>
      </Card>
      <div className="grid gap-4 md:grid-cols-2">{accs.map((a) => { const s = by.get(a.id); return <Card key={a.id}>
        <h2 className="text-[17px] font-semibold">{a.label}{a.last4 ? ` ··${a.last4}` : ""}</h2>
        {s ? <p className="mt-1 text-[14px] text-ink-2">Statements up to {fmtDate(s.last)} · {s.open ? `${s.open} bank line${s.open > 1 ? "s" : ""} not yet matched` : "all lines matched"}</p>
          : <p className="mt-1 text-[14px] text-ink-3">No statement uploaded yet.</p>}
        {s && <div className="mt-3"><LinkButton href={`/money/bank/${a.id}`} variant="secondary">Open reconciliation</LinkButton></div>}
      </Card>; })}</div>
    </>}
  </>;
}
