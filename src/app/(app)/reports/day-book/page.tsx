import Link from "next/link";
import { requireContext } from "@/lib/session";
import { db } from "@/db";
import { dayBook } from "@/lib/accounting/reports";
import { formatINR } from "@/lib/money";
import { todayIST, fmtDate, fyStart } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Button, Card, Input, PageHeader } from "@/components/ui";

export default async function DayBook({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const to = sp.to || todayIST();
  const from = sp.from || fyStart(to);
  const accountant = (await getViewMode()) === "accountant";
  const entries = await dayBook(db, ctx.company.id, from, to);
  return <>
    <PageHeader title={accountant ? "Day book" : "Everything recorded"} subtitle={`${fmtDate(from)} to ${fmtDate(to)} · newest first`} />
    <form className="mb-6 flex flex-wrap items-end gap-3">
      <label className="text-[14px]">From<Input type="date" name="from" defaultValue={from} className="mt-1" /></label>
      <label className="text-[14px]">To<Input type="date" name="to" defaultValue={to} className="mt-1" /></label>
      <Button variant="secondary">Update</Button>
    </form>
    <Card className="overflow-x-auto">
      {entries.length === 0 ? <p className="text-ink-2">No entries in this period.</p> :
      <table className="w-full text-[14px]">
        <caption className="sr-only">Day book</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Date</th><th className="pb-2">Voucher</th><th className="pb-2">Details</th><th className="pb-2 text-right">Amount</th></tr></thead>
        <tbody>{entries.map((e) => <tr key={e.id} className="border-t border-line">
          <td className="py-2 whitespace-nowrap">{fmtDate(e.entryDate)}</td>
          <td className="num whitespace-nowrap"><Link className="hover:underline" href={`/reports/entry/${e.id}`}>{e.voucherNumber}</Link></td>
          <td>{e.narration}{e.status === "REVERSED" && <span className="ml-2 text-[12px] text-ink-3">(cancelled)</span>}</td>
          <td className={`num text-right ${e.status === "REVERSED" ? "text-ink-3 line-through" : ""}`}>{formatINR(e.totalAmount)}</td></tr>)}</tbody>
      </table>}
      {entries.length === 200 && <p className="mt-3 text-[13px] text-ink-3">Showing the latest 200. Narrow the dates to see older entries.</p>}
    </Card>
  </>;
}
