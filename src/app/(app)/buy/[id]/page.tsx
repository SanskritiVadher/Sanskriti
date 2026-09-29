import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getBill } from "@/lib/services/purchases";
import { formatINR, D } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, PageHeader, Status } from "@/components/ui";
import { cancelBillAction } from "@/app/actions-phase4";

export default async function Bill({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; w?: string; cancelled?: string; error?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const { id } = await params;
  const sp = await searchParams;
  const d = await getBill(db, ctx.company.id, id);
  if (!d) notFound();
  const { b, lines, party } = d;
  const warnings: string[] = sp.w ? (() => { try { return JSON.parse(sp.w!); } catch { return []; } })() : [];
  return <>
    <PageHeader title={`${party.name} · bill ${b.billNumber}`} subtitle={`${fmtDate(b.billDate)} · recorded as ${b.number} · due ${fmtDate(b.dueDate)}`} />
    {sp.saved && <div className="mb-3"><Notice tone="good" title="Purchase saved. Stock, GST and what you owe are updated." /></div>}
    {warnings.map((w) => <div key={w} className="mb-3"><Notice tone="warn" title={w} /></div>)}
    {sp.cancelled && <div className="mb-3"><Notice tone="info" title="Purchase cancelled. Stock and dues are restored." /></div>}
    {sp.error && <div className="mb-3"><Notice tone="bad" title={sp.error} /></div>}
    <Card className="mb-6 overflow-x-auto">
      {b.status === "CANCELLED" && <p className="mb-3"><Status tone="neutral">Cancelled: {b.cancelReason}</Status></p>}
      <table className="w-full min-w-[560px] text-[15px]"><caption className="sr-only">Items</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Product</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Rate</th><th className="pb-2 text-right">Taxable</th><th className="pb-2 text-right">GST</th><th className="pb-2 text-right">Cost each (to stock)</th></tr></thead>
        <tbody>{lines.map(({ l, name, unit }) => <tr key={l.id} className="border-t border-line">
          <td className="py-2"><Link className="hover:underline" href={`/inventory/${l.productId}`}>{name}</Link></td>
          <td className="num text-right">{D(l.quantity).toString()} {unit}</td><td className="num text-right">{formatINR(l.rate)}</td><td className="num text-right">{formatINR(l.taxable)}</td>
          <td className="num text-right">{formatINR(D(l.cgst).plus(l.sgst).plus(l.igst))} <span className="text-ink-3">({D(l.gstRate).toString()}%)</span></td>
          <td className="num text-right">{formatINR(l.unitCost)}</td></tr>)}</tbody>
      </table>
      <dl className="ml-auto mt-4 max-w-xs space-y-1 text-[15px]">
        <div className="flex justify-between"><dt>Taxable</dt><dd className="num">{formatINR(b.taxable)}</dd></div>
        {D(b.cgst).gt(0) && <><div className="flex justify-between text-ink-2"><dt>CGST</dt><dd className="num">{formatINR(b.cgst)}</dd></div><div className="flex justify-between text-ink-2"><dt>SGST</dt><dd className="num">{formatINR(b.sgst)}</dd></div></>}
        {D(b.igst).gt(0) && <div className="flex justify-between text-ink-2"><dt>IGST</dt><dd className="num">{formatINR(b.igst)}</dd></div>}
        {!D(b.roundOff).isZero() && <div className="flex justify-between text-ink-3"><dt>Round off</dt><dd className="num">{formatINR(b.roundOff)}</dd></div>}
        <div className="flex justify-between border-t border-ink pt-1 text-[18px] font-semibold"><dt>Total</dt><dd className="num">{formatINR(b.total)}</dd></div>
      </dl>
      <p className="mt-3 text-[13px] text-ink-3">{b.itcClaimed ? "GST on this bill is recorded as claimable (input GST)." : "GST on this bill is included in stock cost (not claimable)."} <Link className="underline" href={`/reports/entry/${b.entryId}`}>Accounting entry</Link> · <Link className="underline" href={`/suppliers/${b.partyId}`}>Supplier account</Link></p>
    </Card>
    {b.status === "ACTIVE" && can(ctx.role, "transactions.cancel") && <Card>
      <h2 className="text-[17px] font-semibold">Cancel this purchase</h2>
      <p className="mb-3 text-[14px] text-ink-2">Only possible if none of this stock has been sold yet.</p>
      <form action={cancelBillAction} className="flex flex-wrap items-end gap-3"><input type="hidden" name="id" value={b.id} />
        <div className="min-w-64 flex-1"><Field label="Reason"><Input name="reason" required /></Field></div><Button variant="secondary">Cancel purchase</Button></form>
    </Card>}
  </>;
}
