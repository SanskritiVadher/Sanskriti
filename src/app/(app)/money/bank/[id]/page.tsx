import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { fmtDate } from "@/lib/dates";
import { formatINR, D } from "@/lib/money";
import { bankAccountsFor, reconciliation } from "@/lib/bank/reconcile";
import { Button, Card, Input, Notice, PageHeader, Status } from "@/components/ui";
import { bankLineStatusAction, matchAction, matchAllSureAction } from "../../../../actions-phase9";

const amt = (b: { deposit: { gt(n: number): boolean; toString(): string }; withdrawal: { toString(): string } }) => b.deposit.gt(0) ? <span className="text-good">+{formatINR(b.deposit.toString())}</span> : <span>−{formatINR(b.withdrawal.toString())}</span>;
const qFor = (b: { date: string; narration: string; deposit: { gt(n: number): boolean; toFixed(n: number): string }; withdrawal: { toFixed(n: number): string } }) =>
  `${b.deposit.gt(0) ? "received" : "paid"} ${(b.deposit.gt(0) ? b.deposit : b.withdrawal).toFixed(2)} bank ${b.date.slice(8, 10)}/${b.date.slice(5, 7)}/${b.date.slice(0, 4)} ${b.narration.replace(/[0-9]+/g, " ").replace(/[@_/.-]+/g, " ")}`;

export default async function Reconcile({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ added?: string; dup?: string; skipped?: string; error?: string; ok?: string; matched?: string }> }) {
  const ctx = await requireContext("money.record");
  const { id } = await params; const sp = await searchParams;
  const acc = (await bankAccountsFor(db, ctx.company.id)).find((a) => a.id === id);
  if (!acc) notFound();
  const r = await reconciliation(db, ctx.company.id, id);
  const hidden = <input type="hidden" name="accountId" value={id} />;
  return <>
    <PageHeader title={`Bank check — ${acc.label}`} subtitle={r ? `Statement lines from ${fmtDate(r.start)} to ${fmtDate(r.to)}` : "No statement yet"} />
    {sp.added && <div className="mb-4"><Notice tone="good" title={`${sp.added} new bank line${sp.added === "1" ? "" : "s"} added.`}>{Number(sp.dup) > 0 && `${sp.dup} were already uploaded and were skipped. `}{Number(sp.skipped) > 0 && `${sp.skipped} non-transaction rows (titles, totals) were ignored.`}</Notice></div>}
    {sp.matched && <div className="mb-4"><Notice tone="good" title={`${sp.matched} matched.`} /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    {!r ? <Card><Link className="text-brand underline" href="/money/bank">Upload a statement</Link></Card> : <>
      <Card className="mb-6">
        <h2 className="text-[18px] font-semibold">Do your books agree with the bank?</h2>
        {r.unexplained == null ? <p className="mt-2 text-[14px] text-ink-2">This statement has no balance column (or no opening balance), so the full check can&rsquo;t be done. Matching still works below.</p> : <>
          <table className="mt-3 w-full max-w-xl text-[15px]"><tbody>
            <tr><td className="py-1">Balance in your books on {fmtDate(r.to)}</td><td className="num text-right">{formatINR(r.bookClose)}</td></tr>
            {!r.startDiff!.isZero() && <tr><td className="py-1 text-ink-2">Difference already there on {fmtDate(r.start)} (bank opening {formatINR(r.bankOpening!)} vs books {formatINR(r.bookBefore)})</td><td className="num text-right">{r.startDiff!.gt(0) ? "+" : "−"}{formatINR(r.startDiff!.abs())}</td></tr>}
            {r.bookOnly.length > 0 && <tr><td className="py-1 text-ink-2">In your books, not yet in the bank ({r.bookOnly.length})</td><td className="num text-right">{(() => { const n = r.bookOnly.reduce((s, k) => s.plus(k.debit).minus(k.credit), D(0)); return `${n.gt(0) ? "−" : "+"}${formatINR(n.abs())}`; })()}</td></tr>}
            {r.bankOnly.length > 0 && <tr><td className="py-1 text-ink-2">In the bank, not in your books ({r.bankOnly.length})</td><td className="num text-right">{(() => { const n = r.bankOnly.reduce((s, b) => s.plus(b.deposit).minus(b.withdrawal), D(0)); return `${n.lt(0) ? "−" : "+"}${formatINR(n.abs())}`; })()}</td></tr>}
            {r.ignored.length > 0 && <tr><td className="py-1 text-ink-2">Bank lines you left out ({r.ignored.length})</td><td className="num text-right">{formatINR(r.ignored.reduce((s, b) => s.plus(b.deposit).minus(b.withdrawal), D(0)))}</td></tr>}
            <tr className="border-t border-line font-semibold"><td className="py-1">Bank balance on the statement</td><td className="num text-right">{formatINR(r.bankClose!)}</td></tr>
          </tbody></table>
          <p className="mt-3">{r.unexplained.isZero()
            ? r.bankOnly.length || r.bookOnly.length ? <Status tone="info">Every rupee of difference is explained by the items below.</Status> : <Status tone="good">Books and bank agree exactly.</Status>
            : <Status tone="bad">{formatINR(r.unexplained.abs())} is not explained — an entry may have a wrong amount, or a bank line was left out of the file.</Status>}</p>
        </>}
        {r.stale > 0 && <p className="mt-2 text-[14px] text-warn">{r.stale} earlier match{r.stale > 1 ? "es were" : " was"} undone because the entry was cancelled.</p>}
      </Card>

      {r.suggestions.length > 0 && <Card className="mb-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-[18px] font-semibold">Suggested matches ({r.suggestions.length})</h2>
          {r.suggestions.some((x) => x.sure) && <form action={matchAllSureAction}>{hidden}<Button variant="secondary">Match all {r.suggestions.filter((x) => x.sure).length} clear ones</Button></form>}</div>
        <p className="mt-1 text-[13px] text-ink-3">Same amount, same direction, dates within a week. &ldquo;Clear&rdquo; means only one possible entry, within 3 days.</p>
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[720px] text-[14px]"><thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Bank</th><th className="pb-2 text-right">Amount</th><th className="pb-2">Your entry</th><th /></tr></thead>
          <tbody>{r.suggestions.map((x) => <tr key={x.bank.id} className="border-t border-line align-top">
            <td className="py-2">{fmtDate(x.bank.date)} · {x.bank.narration}</td><td className="num py-2 text-right">{amt(x.bank)}</td>
            <td className="py-2">{fmtDate(x.book.date)} · <Link className="underline" href={`/reports/entry/${x.book.entryId}`}>{x.book.voucher}</Link> {x.book.party ?? x.book.narration}{!x.sure && <span className="ml-1 text-[12px] text-warn">check</span>}</td>
            <td className="py-2 text-right"><form action={matchAction}>{hidden}<input type="hidden" name="bankLineId" value={x.bank.id} /><input type="hidden" name="journalLineId" value={x.book.id} /><Button variant="secondary">Match</Button></form></td></tr>)}</tbody></table></div>
      </Card>}

      <Card className="mb-6">
        <h2 className="text-[18px] font-semibold">In the bank, not in your books ({r.bankOnly.length})</h2>
        {r.bankOnly.length === 0 ? <p className="mt-2 text-[14px] text-ink-2">None.</p> : <ul className="mt-3 divide-y divide-line">{r.bankOnly.map((b) => { const sugg = r.suggestions.some((x) => x.bank.id === b.id); return <li key={b.id} className="py-3">
          <div className="flex flex-wrap justify-between gap-2"><span>{fmtDate(b.date)} · {b.narration}{b.ref ? ` · ${b.ref}` : ""}</span><span className="num">{amt(b)}</span></div>
          {!sugg && <div className="mt-2 flex flex-wrap items-center gap-3 text-[14px]">
            <Link className="rounded-lg border border-line bg-surface px-3 py-1.5" href={`/assistant?q=${encodeURIComponent(qFor(b))}&bankLine=${b.id}`}>Record it</Link>
            <form action={bankLineStatusAction} className="flex flex-wrap gap-2">{hidden}<input type="hidden" name="bankLineId" value={b.id} /><input type="hidden" name="status" value="IGNORED" />
              <Input name="note" placeholder="Why leave it out?" className="!w-56 !py-1.5 text-[14px]" maxLength={200} /><Button variant="ghost">Leave out</Button></form></div>}
        </li>; })}</ul>}
      </Card>

      <Card className="mb-6">
        <h2 className="text-[18px] font-semibold">In your books, not yet in the bank ({r.bookOnly.length})</h2>
        <p className="mt-1 text-[13px] text-ink-3">Usually cheques not yet cleared. If one is older than a few weeks, check whether it was really paid or deposited.</p>
        {r.bookOnly.length > 0 && <ul className="mt-3 divide-y divide-line text-[14px]">{r.bookOnly.map((k) => { const age = Math.round((Date.parse(r.to) - Date.parse(k.date)) / 86400000); return <li key={k.id} className="flex flex-wrap justify-between gap-2 py-2">
          <span>{fmtDate(k.date)} · <Link className="underline" href={`/reports/entry/${k.entryId}`}>{k.voucher}</Link> {k.party ?? k.narration}{age > 21 && <span className="ml-2 text-warn">{age} days</span>}</span>
          <span className="num">{k.debit.gt(0) ? `+${formatINR(k.debit)}` : `−${formatINR(k.credit)}`}</span></li>; })}</ul>}
      </Card>

      <details className="mb-6"><summary className="cursor-pointer text-[15px] font-semibold text-ink-2">Matched ({r.matched}) and left out ({r.ignored.length})</summary>
        <ul className="mt-3 divide-y divide-line text-[14px]">{r.bank.filter((b) => b.status !== "UNMATCHED").map((b) => <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
          <span>{fmtDate(b.date)} · {b.narration}{b.status === "IGNORED" && <span className="text-ink-3"> — left out: {b.note}</span>}</span>
          <span className="flex items-center gap-3"><span className="num">{amt(b)}</span><form action={bankLineStatusAction}>{hidden}<input type="hidden" name="bankLineId" value={b.id} /><input type="hidden" name="status" value="UNMATCHED" /><button className="text-[13px] text-ink-2 underline">Undo</button></form></span></li>)}</ul></details>
    </>}
  </>;
}
