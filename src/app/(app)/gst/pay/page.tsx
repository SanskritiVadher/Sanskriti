import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { parsePeriod, gstLedgerPosition } from "@/lib/services/gst";
import { cashBankAccounts } from "@/lib/services/vouchers";
import { formatINR } from "@/lib/money";
import { todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, PageHeader, Select } from "@/components/ui";
import { gstPaymentAction } from "@/app/actions-phase5";

export default async function Pay({ searchParams }: { searchParams: Promise<{ period?: string; error?: string }> }) {
  const ctx = await requireContext("gst.configure");
  const sp = await searchParams;
  const period = sp.period ?? todayIST().slice(0, 7);
  const per = parsePeriod(period);
  const [pos, cb] = await Promise.all([gstLedgerPosition(db, ctx.company.id, per.to), cashBankAccounts(db, ctx.company.id)]);
  const s = pos.setoff;
  return <>
    <PageHeader title="Record GST paid" subtitle={`Up to the end of ${per.label}`} />
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card className="mb-6">
      <p className="text-[17px]">Your books say GST to pay in cash is <b className="num">{formatINR(s.cashTotal)}</b>, after using {formatINR(s.used.igst.igst.plus(s.used.igst.cgst).plus(s.used.igst.sgst).plus(s.used.cgst.cgst).plus(s.used.cgst.igst).plus(s.used.sgst.sgst).plus(s.used.sgst.igst))} of purchase credit.</p>
      <ul className="mt-2 text-[14px] text-ink-2"><li>IGST {formatINR(s.cash.igst)} · CGST {formatINR(s.cash.cgst)} · SGST {formatINR(s.cash.sgst)}</li>
        <li>Credit left over: IGST {formatINR(s.carryForward.igst)} · CGST {formatINR(s.carryForward.cgst)} · SGST {formatINR(s.carryForward.sgst)}</li></ul>
      <p className="mt-3 text-[13px] text-ink-3">Record this only after the payment is actually made on the portal (or by your CA). If the portal amount differs, ask your CA before recording.</p>
    </Card>
    <Card><form action={gstPaymentAction} className="grid gap-4 sm:grid-cols-3">
      <input type="hidden" name="asOf" value={per.to} /><input type="hidden" name="period" value={period} />
      <Field label="Paid on"><Input type="date" name="paidOn" defaultValue={todayIST()} required /></Field>
      <Field label="Paid from"><Select name="bankId">{cb.map((a) => <option key={a.id} value={a.id}>{a.ownerLabel}</option>)}</Select></Field>
      <Field label="Challan / CPIN (optional)"><Input name="reference" /></Field>
      <div className="sm:col-span-3"><Button>Record GST set-off and payment</Button></div>
    </form></Card>
  </>;
}
