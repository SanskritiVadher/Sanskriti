import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { listBills } from "@/lib/services/purchases";
import { formatINR, formatINRShort, D } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { Card, LinkButton, PageHeader, Status } from "@/components/ui";

export default async function Buy() {
  const ctx = await requireContext("view.dashboard");
  const list = await listBills(db, ctx.company.id);
  const month = todayIST().slice(0, 7);
  const thisMonth = list.filter(({ b }) => b.status === "ACTIVE" && b.billDate.startsWith(month));
  return <>
    <PageHeader title="Buy" subtitle="Stock you've bought" action={can(ctx.role, "purchases.create") && <LinkButton href="/buy/new">+ Record purchase</LinkButton>} />
    {list.length > 0 && <Card className="mb-6"><p className="text-[14px] text-ink-2">Bought this month (bill totals)</p>
      <p className="num mt-1 text-[32px] font-semibold">{formatINRShort(thisMonth.reduce((s, { b }) => s.plus(b.total), D(0)))}</p>
      <p className="mt-1 text-ink-2">{thisMonth.length} bill{thisMonth.length === 1 ? "" : "s"}. <Link className="text-brand underline" href="/suppliers">See what you owe suppliers →</Link></p></Card>}
    <Card className="overflow-x-auto">
      {list.length === 0 ? <p className="py-6 text-center text-ink-2">No purchases recorded yet.</p> :
      <table className="w-full text-[15px]"><caption className="sr-only">Purchase bills</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Date</th><th className="pb-2">Supplier</th><th className="pb-2">Their bill no.</th><th className="pb-2 text-right">Total</th><th className="hidden pb-2 sm:table-cell">Due</th></tr></thead>
        <tbody>{list.map(({ b, supplier }) => <tr key={b.id} className="border-t border-line">
          <td className="py-2.5 whitespace-nowrap">{fmtDate(b.billDate)}</td><td><Link className="hover:underline" href={`/buy/${b.id}`}>{supplier}</Link></td>
          <td className="num">{b.billNumber}</td>
          <td className={`num text-right ${b.status === "CANCELLED" ? "text-ink-3 line-through" : ""}`}>{formatINR(b.total)}</td>
          <td className="hidden sm:table-cell">{b.status === "CANCELLED" ? <Status tone="neutral">Cancelled</Status> : fmtDate(b.dueDate)}</td></tr>)}</tbody>
      </table>}
    </Card>
  </>;
}
