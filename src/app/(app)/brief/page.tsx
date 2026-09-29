import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { fmtDate } from "@/lib/dates";
import { formatINRShort } from "@/lib/money";
import { dailyBrief } from "@/lib/services/brief";
import { Card, PageHeader, Status } from "@/components/ui";

export default async function Brief() {
  const ctx = await requireContext("reports.financial");
  const b = await dailyBrief(db, ctx.company.id);
  const phone = (ctx.company.phone ?? "").replace(/\D/g, "").slice(-10);
  const wa = `https://wa.me/${phone.length === 10 ? "91" + phone : ""}?text=${encodeURIComponent(b.text)}`;
  const Row = ({ href, children }: { href: string; children: React.ReactNode }) => <li><Link href={href} className="flex flex-wrap justify-between gap-2 rounded-lg px-3 py-2 hover:bg-surface-2">{children}</Link></li>;
  return <>
    <PageHeader title="Today" subtitle={fmtDate(b.today)} action={<a href={wa} target="_blank" rel="noopener noreferrer" className="rounded-lg border border-line bg-surface px-4 py-2 text-[14px]">Send to my WhatsApp</a>} />
    <div className="grid gap-4 md:grid-cols-2">
      <Card><h2 className="text-[17px] font-semibold">Money</h2>
        <p className="num mt-2 text-[26px] font-semibold">{formatINRShort(b.money.total)}</p><p className="text-[13px] text-ink-3">Cash and bank now</p>
        <p className="mt-3 text-[14px]">Yesterday: sales <b>{formatINRShort(b.yday.sales)}</b> ({b.yday.bills} bill{b.yday.bills === 1 ? "" : "s"}), money in <b>{formatINRShort(b.yday.received)}</b>, money out <b>{formatINRShort(b.yday.paid)}</b>.</p>
        <Link className="mt-2 inline-block text-[14px] text-brand underline" href="/reports/day-book">Yesterday&rsquo;s entries</Link></Card>
      <Card><h2 className="text-[17px] font-semibold">Call today</h2>
        {b.call.length ? <><p className="text-[13px] text-ink-3">{formatINRShort(b.overdueTotal)} overdue in total — biggest and oldest first.</p>
          <ul className="mt-2">{b.call.map((p) => <Row key={p.id} href={`/customers/${p.id}#remind`}><span>{p.name}{p.oldest > 0 && <span className="text-ink-3"> · {p.oldest} days late</span>}</span><span className="num">{formatINRShort(p.overdue.plus(p.oldBalance))}</span></Row>)}</ul></>
          : <p className="mt-2"><Status tone="good">No overdue customers.</Status></p>}</Card>
      <Card><h2 className="text-[17px] font-semibold">Pay soon</h2>
        {b.pay.length ? <ul className="mt-2">{b.pay.map((p) => <Row key={p.id} href={`/suppliers/${p.id}`}><span>{p.name}{p.overdue.gt(0) && <span className="text-warn"> · overdue</span>}</span><span className="num">{formatINRShort(p.overdue.plus(p.dueSoon))}</span></Row>)}</ul>
          : <p className="mt-2 text-[14px] text-ink-2">Nothing due to suppliers in the next 7 days.</p>}</Card>
      <Card><h2 className="text-[17px] font-semibold">Stock to reorder</h2>
        {b.reorder.length ? <ul className="mt-2">{b.reorder.map((i) => <Row key={i.id} href={`/inventory/${i.id}`}><span>{i.name} <span className="text-ink-3">· {i.health === "OUT" ? "out of stock" : `${i.qty.toString()} ${i.unit} left`}</span></span><span className="text-ink-2">{i.suggestQty ? `order ~${i.suggestQty}` : ""}</span></Row>)}</ul>
          : <p className="mt-2 text-[14px] text-ink-2">Nothing out or running low.</p>}</Card>
      <Card><h2 className="text-[17px] font-semibold">Check</h2><ul className="mt-2 space-y-1 text-[14px]">
        <li>{b.odd.length ? <Link className="underline" href="/assistant/checks">{b.odd.length} unusual item{b.odd.length > 1 ? "s" : ""} to look at</Link> : "Nothing unusual."}</li>
        <li>{b.bank.last ? <Link className="underline" href="/money/bank">Bank statement up to {fmtDate(b.bank.last)}{b.bank.open ? ` · ${b.bank.open} line${b.bank.open > 1 ? "s" : ""} not matched` : ""}</Link> : <Link className="underline" href="/money/bank">No bank statement uploaded yet</Link>}</li>
      </ul></Card>
    </div>
    <p className="mt-6 text-[14px]"><Link className="text-brand underline" href="/brief/week">Weekly review →</Link></p>
  </>;
}
