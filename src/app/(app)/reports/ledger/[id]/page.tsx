import Link from "next/link";
import { notFound } from "next/navigation";
import { requireContext } from "@/lib/session";
import { db } from "@/db";
import { accountLedger } from "@/lib/accounting/reports";
import { formatINR } from "@/lib/money";
import { todayIST, fmtDate, fyStart } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Button, Card, Input, PageHeader } from "@/components/ui";

export default async function Ledger({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const { id } = await params;
  const sp = await searchParams;
  const to = sp.to || todayIST();
  const from = sp.from || fyStart(to);
  const accountant = (await getViewMode()) === "accountant";
  const l = await accountLedger(db, ctx.company.id, id, from, to);
  if (!l) notFound();
  const name = accountant ? `${l.account.code} · ${l.account.name}` : l.account.ownerLabel;
  const unusual = l.closing.isNegative();

  return <>
    <PageHeader title={name} subtitle={`Statement from ${fmtDate(from)} to ${fmtDate(to)}`} />
    <form className="mb-6 flex flex-wrap items-end gap-3">
      <label className="text-[14px]">From<Input type="date" name="from" defaultValue={from} className="mt-1" /></label>
      <label className="text-[14px]">To<Input type="date" name="to" defaultValue={to} className="mt-1" /></label>
      <Button variant="secondary">Update</Button>
    </form>
    <div className="mb-6 grid gap-4 sm:grid-cols-3">
      <Card><p className="text-[13px] text-ink-2">Balance at start</p><p className="num mt-1 text-[22px] font-semibold">{formatINR(l.opening)}</p></Card>
      <Card><p className="text-[13px] text-ink-2">Movement in this period</p><p className="num mt-1 text-[22px] font-semibold">{formatINR(l.closing.minus(l.opening))}</p>
        <p className="text-[13px] text-ink-3">{l.lines.length} entr{l.lines.length === 1 ? "y" : "ies"}</p></Card>
      <Card><p className="text-[13px] text-ink-2">Balance at end</p><p className={`num mt-1 text-[22px] font-semibold ${unusual ? "text-warn" : ""}`}>{formatINR(l.closing)}</p>
        {unusual && <p className="text-[13px] text-warn">⚠ Below zero. Unusual for this type of account; worth checking.</p>}</Card>
    </div>
    <Card className="overflow-x-auto">
      {l.lines.length === 0 ? <p className="text-ink-2">No entries in this period.</p> :
      <table className="w-full text-[14px]">
        <caption className="sr-only">Account statement</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Date</th><th className="pb-2">Details</th>
          {accountant && <th className="pb-2">Voucher</th>}<th className="pb-2 text-right">{accountant ? "Debit" : "In / Increase"}</th>
          <th className="pb-2 text-right">{accountant ? "Credit" : "Out / Decrease"}</th><th className="pb-2 text-right">Balance</th></tr></thead>
        <tbody>{l.lines.map((r) => {
          const debitSide = l.account.nature === "ASSET" || l.account.nature === "EXPENSE";
          const inc = accountant ? r.debit : debitSide ? r.debit : r.credit;
          const dec = accountant ? r.credit : debitSide ? r.credit : r.debit;
          return <tr key={r.lineId} className="border-t border-line">
            <td className="py-2 whitespace-nowrap">{fmtDate(r.date)}</td>
            <td><Link className="hover:underline" href={`/reports/entry/${r.entryId}`}>{r.lineNarration || r.narration || r.voucherType.toLowerCase()}</Link>
              {r.status === "REVERSED" && <span className="ml-2 text-[12px] text-ink-3">(cancelled)</span>}</td>
            {accountant && <td className="num text-ink-3">{r.voucherNumber}</td>}
            <td className="num text-right">{inc.isZero() ? "" : formatINR(inc)}</td>
            <td className="num text-right">{dec.isZero() ? "" : formatINR(dec)}</td>
            <td className="num text-right">{formatINR(r.balance)}</td></tr>; })}</tbody>
      </table>}
    </Card>
  </>;
}
