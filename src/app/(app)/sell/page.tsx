import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { listSales } from "@/lib/services/sales";
import { formatINR, formatINRShort, D } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { Card, Input, LinkButton, PageHeader, Status } from "@/components/ui";

export default async function Sell({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const list = await listSales(db, ctx.company.id, { q: sp.q });
  const month = todayIST().slice(0, 7);
  const thisMonth = list.filter((i) => i.status === "ACTIVE" && i.invoiceDate.startsWith(month));
  const total = thisMonth.reduce((s, i) => s.plus(i.taxable), D(0));
  const profit = thisMonth.reduce((s, i) => s.plus(i.taxable).minus(i.costOfGoods), D(0));
  return <>
    <PageHeader title="Sell" subtitle="Bills you've made" action={can(ctx.role, "sales.create") && <LinkButton href="/sell/new">+ New bill</LinkButton>} />
    {list.length > 0 && <Card className="mb-6">
      <p className="text-[14px] text-ink-2">Sales this month (before GST)</p>
      <p className="num mt-1 text-[32px] font-semibold">{formatINRShort(total)}</p>
      <p className="mt-1 text-ink-2">{thisMonth.length} bill{thisMonth.length === 1 ? "" : "s"}{total.gt(0) && ` · profit before expenses ${formatINRShort(profit)} (${profit.div(total).mul(100).toFixed(1)}% margin)`}.</p>
    </Card>}
    <form className="mb-4"><Input name="q" defaultValue={sp.q} placeholder="Search customer or bill number" aria-label="Search bills" /></form>
    <Card className="overflow-x-auto">
      {list.length === 0 ? <p className="py-6 text-center text-ink-2">No bills yet.{can(ctx.role, "sales.create") && <> <Link className="text-brand underline" href="/sell/new">Make the first bill</Link>.</>}</p> :
      <table className="w-full text-[15px]"><caption className="sr-only">Sales bills</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Date</th><th className="pb-2">Bill no.</th><th className="pb-2">Customer</th><th className="pb-2 text-right">Total</th><th className="hidden pb-2 sm:table-cell">Status</th></tr></thead>
        <tbody>{list.map((i) => <tr key={i.id} className="border-t border-line">
          <td className="py-2.5 whitespace-nowrap">{fmtDate(i.invoiceDate)}</td>
          <td className="num"><Link className="hover:underline" href={`/sell/${i.id}`}>{i.number}</Link></td>
          <td>{i.customerName}</td>
          <td className={`num text-right ${i.status === "CANCELLED" ? "text-ink-3 line-through" : ""}`}>{formatINR(i.total)}</td>
          <td className="hidden sm:table-cell">{i.status === "CANCELLED" ? <Status tone="neutral">Cancelled</Status> : D(i.paidAtSale).gte(i.total) ? <Status tone="good">Paid</Status> : <Status tone="info">On credit</Status>}</td>
        </tr>)}</tbody>
      </table>}
    </Card>
  </>;
}
