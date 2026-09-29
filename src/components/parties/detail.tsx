import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/db";
import { partyStatement, whatsappReminderLink } from "@/lib/services/parties";
import { openItems } from "@/lib/services/receivables";
import { cashBankAccounts } from "@/lib/services/vouchers";
import { stateByCode } from "@/lib/gst/states";
import { formatINR, formatINRShort } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, LinkButton, Notice, PageHeader, Select, Status } from "@/components/ui";
import { partyPaymentAction } from "@/app/actions-phase3";

export async function PartyDetail({ id, companyId, businessName, sp, canPay, canEdit }: { id: string; companyId: string; businessName: string; sp: Record<string, string | undefined>; canPay: boolean; canEdit: boolean }) {
  const st = await partyStatement(db, companyId, id);
  if (!st) notFound();
  const { party: p, lines, balance } = st;
  const C = p.type === "CUSTOMER";
  const base = C ? "/customers" : "/suppliers";
  const cb = canPay ? await cashBankAccounts(db, companyId) : [];
  const limit = p.creditLimit ? Number(p.creditLimit) : null;
  const usage = limit && limit > 0 ? Math.round((Number(balance.toFixed(2)) / limit) * 100) : null;
  const oi = (await openItems(db, companyId, id))!;
  const wa = C && balance.gt(0) ? whatsappReminderLink(p, businessName, formatINR(balance),
    oi.open.map((i) => ({ number: i.number, date: fmtDate(i.date), open: formatINR(i.open), daysOverdue: i.daysOverdue, ageUnknown: i.ageUnknown }))) : null;
  const lastPay = [...lines].reverse().find((l) => (l.voucherType === "RECEIPT" || l.voucherType === "PAYMENT") && l.status === "POSTED");

  const headline = balance.isZero() ? (C ? `${p.name} doesn't owe you anything.` : `You don't owe ${p.name} anything.`)
    : balance.gt(0) ? (C ? `${p.name} owes you ${formatINRShort(balance)}.` : `You owe ${p.name} ${formatINRShort(balance)}.`)
    : (C ? `${p.name} has paid you ${formatINRShort(balance.neg())} in advance.` : `You have paid ${p.name} ${formatINRShort(balance.neg())} in advance.`);

  return <>
    <PageHeader title={p.name} subtitle={[p.city, stateByCode(p.stateCode)?.name, p.gstin].filter(Boolean).join(" · ") || (C ? "Customer" : "Supplier")}
      action={canEdit && <LinkButton href={`${base}/${p.id}/edit`} variant="secondary">Edit details</LinkButton>} />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Saved." /></div>}
    {sp.paid && <div className="mb-4"><Notice tone="good" title="Payment recorded. The balance below is updated." /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    {sp.w && (() => { try { return (JSON.parse(sp.w) as string[]).map((w) => <div key={w} className="mb-4"><Notice tone="warn" title={w} /></div>); } catch { return null; } })()}

    <Card className="mb-6">
      <p className="text-[22px] font-semibold">{headline}</p>
      <ul className="mt-3 space-y-1 text-ink-2">
        {C && limit != null && <li>Credit limit: {formatINR(limit)}{usage != null && balance.gt(0) && <> · using {usage}%
          {usage > 100 && <span className="ml-2"><Status tone="warn">Over limit by {formatINR(balance.minus(limit))}</Status></span>}</>}</li>}
        {p.creditDays != null && <li>{C ? "Credit period you give" : "Credit period they give you"}: {p.creditDays} days</li>}
        <li>Last payment: {lastPay ? `${fmtDate(lastPay.date)} (${formatINR(lastPay.voucherType === "RECEIPT" ? lastPay.credit.plus(lastPay.debit) : lastPay.debit.plus(lastPay.credit))})` : "none recorded yet"}</li>
        {oi.overdue.gt(0) && <li><Status tone="bad">{formatINR(oi.overdue)} overdue</Status> <span className="ml-1">oldest by {oi.oldestOverdueDays} days</span></li>}
        {oi.oldBalance.gt(0) && <li>{formatINR(oi.oldBalance)} is old balance from before the app. <span className="text-ink-3">Its bill dates aren&rsquo;t known, so no overdue days are shown for it.</span></li>}
        {oi.dueSoon.gt(0) && <li><Status tone="warn">{formatINR(oi.dueSoon)} due in the next 7 days</Status></li>}
        <li>Payment habit: {oi.habit ? (oi.habit.avgDaysLate > 0 ? `usually pays ${oi.habit.avgDaysLate} days after the due date` : oi.habit.avgDaysLate < 0 ? `usually pays ${-oi.habit.avgDaysLate} days early` : "usually pays on time")
          + ` (based on ${oi.habit.count} bills; on time ${oi.habit.onTime} of ${oi.habit.count})` : "not enough paid bills yet to say"}</li>
      </ul>
      <div className="mt-4 flex flex-wrap gap-2">
        {p.phone && <a href={`tel:+91${p.phone}`} className="rounded-lg border border-line px-4 py-2 text-[15px]">📞 Call {p.phone}</a>}
        {wa && <a id="remind" href={wa} target="_blank" rel="noopener noreferrer" className="rounded-lg bg-good px-4 py-2 text-[15px] text-white">Send WhatsApp reminder</a>}
        {C && balance.gt(0) && !p.whatsapp && <span className="py-2 text-[14px] text-ink-3">Add a mobile number to send WhatsApp reminders.</span>}
      </div>
    </Card>

    {canPay && <Card className="mb-6">
      <h2 className="mb-4 text-[17px] font-semibold">{C ? "Record payment received" : "Record payment made"}</h2>
      <form action={partyPaymentAction} className="grid gap-4 sm:grid-cols-4">
        <input type="hidden" name="id" value={p.id} /><input type="hidden" name="type" value={p.type} />
        <Field label="Amount (₹)"><Input name="amount" inputMode="decimal" required defaultValue={sp.amount} className="num" /></Field>
        <Field label={C ? "Received into" : "Paid from"}><Select name="cashBankId" required>{cb.map((a) => <option key={a.id} value={a.id}>{a.ownerLabel}</option>)}</Select></Field>
        <Field label="Date"><Input type="date" name="date" defaultValue={todayIST()} required /></Field>
        <Field label="Note"><Input name="narration" placeholder="e.g. UPI, cheque 1234" /></Field>
        <div className="sm:col-span-4"><Button>Save payment</Button></div>
      </form>
    </Card>}

    {oi.open.length > 0 && <Card className="mb-6 overflow-x-auto">
      <h2 className="mb-1 text-[17px] font-semibold">{C ? "Unpaid bills" : "Bills to pay"}</h2>
      <p className="mb-3 text-[13px] text-ink-3">Payments are applied to the oldest bill first.</p>
      <table className="w-full text-[15px]"><caption className="sr-only">Open bills</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Bill</th><th className="pb-2">Date</th><th className="pb-2">Due</th><th className="pb-2 text-right">Still unpaid</th><th className="pb-2">Status</th></tr></thead>
        <tbody>{oi.open.map((i) => <tr key={i.entryId} className="border-t border-line">
          <td className="py-2">{i.docId ? <Link className="hover:underline" href={`${C ? "/sell" : "/buy"}/${i.docId}`}>{i.number}</Link> : i.number}</td>
          <td className="whitespace-nowrap">{fmtDate(i.date)}</td><td className="whitespace-nowrap">{fmtDate(i.dueDate)}</td>
          <td className="num text-right">{formatINR(i.open)}{i.open.lt(i.amount) && <span className="block text-[12px] text-ink-3">of {formatINR(i.amount)}</span>}</td>
          <td>{i.ageUnknown ? <Status tone="neutral">Old balance · age not known</Status> : i.daysOverdue > 0 ? <Status tone="bad">{i.daysOverdue} days late</Status> : <Status tone="info">Not due yet</Status>}</td></tr>)}</tbody>
      </table>
      {oi.advance.gt(0) && <p className="mt-2 text-[14px] text-ink-2">Advance not yet used: {formatINR(oi.advance)}</p>}
    </Card>}

    <Card className="overflow-x-auto">
      <h2 className="mb-3 text-[17px] font-semibold">History</h2>
      {lines.length === 0 ? <p className="text-ink-2">Nothing recorded yet.</p> :
      <table className="w-full text-[14px]">
        <caption className="sr-only">Statement</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Date</th><th className="pb-2">Details</th>
          <th className="pb-2 text-right">{C ? "Billed / owed" : "Bought / owed"}</th><th className="pb-2 text-right">Paid</th><th className="pb-2 text-right">Balance</th></tr></thead>
        <tbody>{lines.map((l) => { const up = C ? l.debit : l.credit, down = C ? l.credit : l.debit;
          return <tr key={l.lineId} className="border-t border-line">
            <td className="py-2 whitespace-nowrap">{fmtDate(l.date)}</td>
            <td><Link className="hover:underline" href={`/reports/entry/${l.entryId}`}>{l.narration}</Link>{l.status === "REVERSED" && <span className="ml-2 text-[12px] text-ink-3">(cancelled)</span>}</td>
            <td className="num text-right">{up.isZero() ? "" : formatINR(up)}</td>
            <td className="num text-right">{down.isZero() ? "" : formatINR(down)}</td>
            <td className="num text-right">{formatINR(l.balance)}</td></tr>; })}</tbody>
      </table>}
    </Card>
  </>;
}
