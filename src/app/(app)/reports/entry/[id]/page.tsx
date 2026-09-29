import Link from "next/link";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/db";
import { entryDetail } from "@/lib/accounting/reports";
import { formatINR } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Button, Card, Field, Input, Notice, PageHeader, Status } from "@/components/ui";
import { reverseEntryAction } from "../../../../actions-ledger";

export default async function Entry({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; reversed?: string; error?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const { id } = await params;
  const sp = await searchParams;
  const d = await entryDetail(db, ctx.company.id, id);
  if (!d) notFound();
  const accountant = (await getViewMode()) === "accountant";
  const { entry: e } = d;
  const canReverse = can(ctx.role, "transactions.cancel") && e.status === "POSTED" && e.voucherType !== "REVERSAL";

  return <>
    <PageHeader title={e.narration || e.voucherNumber} subtitle={`${e.voucherNumber} · ${fmtDate(e.entryDate)}`} />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Saved. Your books are updated." /></div>}
    {sp.reversed && <div className="mb-4"><Notice tone="good" title="Cancelled. This reversal entry undoes the original; both stay on record." /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    {e.status === "REVERSED" && d.relatedEntry && <div className="mb-4"><Notice tone="warn" title="This entry was cancelled.">
      Reason: {e.reversalReason}. See <Link className="underline" href={`/reports/entry/${d.relatedEntry.id}`}>{d.relatedEntry.voucherNumber}</Link>.</Notice></div>}
    {e.voucherType === "REVERSAL" && d.relatedEntry && <div className="mb-4"><Notice tone="info" title="This entry cancels an earlier one.">
      Original: <Link className="underline" href={`/reports/entry/${d.relatedEntry.id}`}>{d.relatedEntry.voucherNumber}</Link>.</Notice></div>}

    <Card className="mb-6 overflow-x-auto">
      <table className="w-full text-[15px]">
        <caption className="sr-only">Entry lines</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Account</th><th className="pb-2 text-right">Debit</th><th className="pb-2 text-right">Credit</th></tr></thead>
        <tbody>{d.lines.map((l) => <tr key={l.id} className="border-t border-line">
          <td className="py-2"><Link className="hover:underline" href={`/reports/ledger/${l.accountId}`}>{accountant ? `${l.code} · ${l.name}` : l.ownerLabel}</Link>
            {l.narration && <span className="block text-[13px] text-ink-3">{l.narration}</span>}</td>
          <td className="num text-right">{Number(l.debit) ? formatINR(l.debit) : ""}</td>
          <td className="num text-right">{Number(l.credit) ? formatINR(l.credit) : ""}</td></tr>)}</tbody>
        <tfoot><tr className="border-t-2 border-ink font-semibold"><td className="py-2">Total</td>
          <td className="num text-right">{formatINR(e.totalAmount)}</td><td className="num text-right">{formatINR(e.totalAmount)}</td></tr></tfoot>
      </table>
      <p className="mt-3"><Status tone="good">Balanced</Status></p>
      <dl className="mt-4 grid gap-1 text-[13px] text-ink-2 sm:grid-cols-2">
        <div>Recorded by: {d.createdByName}</div>
        <div>Recorded at: {e.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</div>
        <div>Source: {e.sourceType}</div>
        <div>Status: {e.status === "POSTED" ? "Active" : "Cancelled"}</div>
      </dl>
    </Card>

    {canReverse && <Card>
      <h2 className="text-[17px] font-semibold">Made a mistake?</h2>
      <p className="mb-4 text-[14px] text-ink-2">Entries are never deleted. Cancelling creates an opposite entry, so the history stays complete. Then record the correct entry.</p>
      <form action={reverseEntryAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="entryId" value={e.id} />
        <div className="min-w-64 flex-1"><Field label="Reason"><Input name="reason" required placeholder="e.g. wrong amount entered" /></Field></div>
        <Button variant="secondary">Cancel this entry</Button>
      </form>
    </Card>}
  </>;
}
