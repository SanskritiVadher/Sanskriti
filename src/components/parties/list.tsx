import Link from "next/link";
import { db } from "@/db";
import { listParties, type PartyType } from "@/lib/services/parties";
import { formatINR, formatINRShort, D } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Card, Input, LinkButton, Notice, PageHeader, Status } from "@/components/ui";

export async function PartyList({ type, companyId, q, imported, canEdit }: { type: PartyType; companyId: string; q?: string; imported?: string; canEdit: boolean }) {
  const list = await listParties(db, companyId, type, q);
  const C = type === "CUSTOMER";
  const base = C ? "/customers" : "/suppliers";
  const owing = list.filter((p) => p.balance.gt(0)).sort((a, b) => b.balance.comparedTo(a.balance));
  const advance = list.filter((p) => p.balance.lt(0));
  const total = owing.reduce((s, p) => s.plus(p.balance), D(0));
  const top3 = owing.slice(0, 3).reduce((s, p) => s.plus(p.balance), D(0));

  return <>
    <PageHeader title={C ? "Customers" : "Suppliers"} subtitle={C ? "Who owes me money?" : "Whom do I need to pay?"}
      action={canEdit && <div className="flex gap-2"><LinkButton href={`${base}/new`}>+ Add {C ? "customer" : "supplier"}</LinkButton>
        <LinkButton href={`/import?kind=${C ? "customers" : "suppliers"}`} variant="secondary">Import from Excel / Tally</LinkButton></div>} />
    {imported && <div className="mb-4"><Notice tone="good" title={`${imported} ${C ? "customers" : "suppliers"} imported.`} /></div>}

    {list.length > 0 && <Card className="mb-6">
      <p className="text-[14px] text-ink-2">{C ? "Customers owe you" : "You owe suppliers"}</p>
      <p className="num mt-1 text-[34px] font-semibold tracking-tight">{formatINRShort(total)}</p>
      <p className="mt-1 text-ink-2">
        {owing.length === 0 ? (C ? "Nobody owes you anything right now." : "You don't owe any supplier right now.")
          : `${owing.length} ${C ? "customer" : "supplier"}${owing.length === 1 ? "" : "s"}${owing.length > 3 ? `. The top 3 account for ${total.isZero() ? 0 : top3.div(total).mul(100).toFixed(0)}% of it` : ""}.`}
        {advance.length > 0 && ` ${advance.length} ${C ? "have paid you in advance" : "have been paid in advance"}.`}</p>
      {C && owing.length > 0 && <p className="mt-3 text-[13px] text-ink-3">Overdue days and a &ldquo;call these first&rdquo; list need bill dates, which come with billing (Phase 4). For now this is sorted by amount.</p>}
    </Card>}

    <form className="mb-4"><Input name="q" defaultValue={q} placeholder={`Search by name, phone, city or GSTIN`} aria-label="Search" /></form>
    <Card className="overflow-x-auto">
      {list.length === 0 ? <div className="py-6 text-center">
        <p className="text-ink-2">{q ? "No match." : `No ${C ? "customers" : "suppliers"} yet.`}</p>
        {!q && canEdit && <p className="mt-2 text-[14px]">Add them one by one, or <Link className="text-brand underline" href={`/import?kind=${C ? "customers" : "suppliers"}`}>import your list from Tally / Excel</Link>.</p>}
      </div> :
      <table className="w-full text-[15px]">
        <caption className="sr-only">{C ? "Customers" : "Suppliers"}</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Name</th><th className="hidden pb-2 sm:table-cell">City</th><th className="hidden pb-2 sm:table-cell">Phone</th>
          <th className="pb-2 text-right">{C ? "Owes you" : "You owe"}</th><th className="hidden pb-2 text-right sm:table-cell">Last payment</th></tr></thead>
        <tbody>{[...owing, ...list.filter((p) => !p.balance.gt(0))].map((p) => {
          const overLimit = C && p.creditLimit && p.balance.gt(p.creditLimit);
          return <tr key={p.id} className={`border-t border-line ${!p.isActive ? "opacity-50" : ""}`}>
            <td className="py-2.5"><Link href={`${base}/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
              {overLimit && <span className="ml-2"><Status tone="warn">Over credit limit</Status></span>}</td>
            <td className="hidden text-ink-2 sm:table-cell">{p.city}</td>
            <td className="num hidden text-ink-2 sm:table-cell">{p.phone}</td>
            <td className={`num text-right ${p.balance.lt(0) ? "text-info" : ""}`}>{p.balance.isZero() ? "—" : p.balance.lt(0) ? `${formatINR(p.balance.neg())} adv.` : formatINR(p.balance)}</td>
            <td className="hidden text-right text-[14px] text-ink-2 sm:table-cell">{p.lastPayment ? fmtDate(p.lastPayment) : "—"}</td></tr>; })}</tbody>
      </table>}
    </Card>
  </>;
}
