import Link from "next/link";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { getInvoice } from "@/lib/services/sales";
import { openItems } from "@/lib/services/receivables";
import { formatINR, D } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, Status } from "@/components/ui";
import { InvoiceView } from "@/components/docs/invoice-view";
import { PrintButton } from "@/components/docs/print-button";
import { cancelSaleAction } from "@/app/actions-phase4";
import { notesFor } from "@/lib/services/notes";

export default async function Invoice({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; w?: string; cancelled?: string; error?: string; returned?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const { id } = await params;
  const sp = await searchParams;
  const d = await getInvoice(db, { companyId: ctx.company.id, id });
  if (!d) notFound();
  const { inv } = d;
  const [oi, notes] = await Promise.all([openItems(db, ctx.company.id, inv.partyId), notesFor(db, ctx.company.id, { invoiceId: inv.id })]);
  const item = oi?.items.find((i) => i.docId === inv.id);
  const party = oi?.party;
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const link = `${origin}/i/${inv.shareToken}`;
  const warnings: string[] = sp.w ? (() => { try { return JSON.parse(sp.w!); } catch { return []; } })() : [];
  const waText = `Namaste ${inv.customerName} ji,\n\nYour bill ${inv.number} dated ${fmtDate(inv.invoiceDate)} from ${ctx.company.name} for ${formatINR(inv.total)}${item && item.open.gt(0) ? `, due by ${fmtDate(inv.dueDate)}` : ""}.\n\nView / download: ${link}\n\nThank you.`;
  const wa = party?.whatsapp ? `https://wa.me/91${party.whatsapp}?text=${encodeURIComponent(waText)}` : `https://wa.me/?text=${encodeURIComponent(waText)}`;

  return <>
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
      <div><h1 className="text-[26px] font-semibold">{inv.number}</h1>
        <p className="text-ink-2">{inv.customerName} · {formatINR(inv.total)} · {inv.status === "CANCELLED" ? <Status tone="neutral">Cancelled</Status>
          : item ? (item.open.isZero() ? <Status tone="good">Paid</Status> : item.daysOverdue > 0 ? <Status tone="bad">{formatINR(item.open)} overdue by {item.daysOverdue} days</Status>
            : <Status tone="info">{formatINR(item.open)} due {fmtDate(inv.dueDate)}</Status>) : null}</p></div>
      <div className="flex flex-wrap gap-2">
        {inv.status === "ACTIVE" && <a href={wa} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-good px-4 py-2.5 text-[15px] text-white">Send on WhatsApp</a>}
        <a href={`/sell/${inv.id}/pdf`} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[15px]">Download PDF</a>
        <PrintButton />
        {inv.status === "ACTIVE" && can(ctx.role, "sales.create") && <Link href={`/sell/${inv.id}/return`} className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[15px]">Goods returned</Link>}
        {can(ctx.role, "sales.create") && <Link href="/sell/new" className="rounded-lg border border-line bg-surface px-4 py-2.5 text-[15px]">+ New bill</Link>}
      </div>
    </div>
    <div className="print:hidden">
      {sp.saved && <div className="mb-3"><Notice tone="good" title="Bill saved. Stock, customer dues, GST and accounts are updated." /></div>}
      {warnings.map((w) => <div key={w} className="mb-3"><Notice tone="warn" title={w} /></div>)}
      {sp.returned && <div className="mb-3"><Notice tone="good" title={`Credit note ${sp.returned} saved. Stock, customer dues and GST are updated.`} /></div>}
      {sp.cancelled && <div className="mb-3"><Notice tone="info" title="Bill cancelled. Stock and dues are restored. The bill number stays on record as cancelled." /></div>}
      {sp.error && <div className="mb-3"><Notice tone="bad" title={sp.error} /></div>}
      {inv.status === "ACTIVE" && !party?.whatsapp && <p className="mb-3 text-[13px] text-ink-3">No WhatsApp number saved for this customer; WhatsApp will ask you to pick the chat.</p>}
    </div>
    <InvoiceView {...d} />
    {notes.length > 0 && <Card className="mt-4 print:hidden"><h2 className="font-semibold">Returns on this bill</h2>
      <ul className="mt-2 text-[14px]">{notes.map((n) => <li key={n.id} className="flex justify-between border-t border-line py-2"><Link className="hover:underline" href={`/reports/entry/${n.entryId}`}>{n.number} · {fmtDate(n.noteDate)} · {n.reason}</Link><span className="num">−{formatINR(n.total)}</span></li>)}</ul></Card>}
    <p className="mt-3 text-[13px] text-ink-3 print:hidden">The WhatsApp message includes a private link to this bill only. Anyone with the link can view this one bill.
      {inv.creditOverrideReason && ` Credit limit override: ${inv.creditOverrideReason}.`} <Link className="underline" href={`/reports/entry/${inv.entryId}`}>Accounting entry</Link></p>

    {inv.status === "ACTIVE" && can(ctx.role, "transactions.cancel") && <Card className="mt-6 print:hidden">
      <h2 className="text-[17px] font-semibold">Cancel this bill</h2>
      <p className="mb-3 text-[14px] text-ink-2">For a bill made by mistake. If only some goods came back, use &ldquo;Goods returned&rdquo; instead. Stock comes back, the customer&rsquo;s dues go down, and GST is reversed. {D(inv.paidAtSale).gt(0) && "Money already received stays recorded as an advance from this customer."}</p>
      <form action={cancelSaleAction} className="flex flex-wrap items-end gap-3"><input type="hidden" name="id" value={inv.id} />
        <div className="min-w-64 flex-1"><Field label="Reason"><Input name="reason" required placeholder="e.g. wrong customer, order cancelled" /></Field></div>
        <Button variant="secondary">Cancel bill</Button></form>
    </Card>}
  </>;
}
