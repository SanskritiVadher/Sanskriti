import Link from "next/link";
import { db } from "@/db";
import { listParties, whatsappReminderLink, type PartyType } from "@/lib/services/parties";
import { ageing } from "@/lib/services/receivables";
import { todayIST } from "@/lib/dates";
import { formatINR, formatINRShort, D } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import { Card, Input, LinkButton, Notice, PageHeader, Status } from "@/components/ui";

export async function PartyList({ type, companyId, q, imported, canEdit, businessName }: { type: PartyType; companyId: string; q?: string; imported?: string; canEdit: boolean; businessName: string }) {
  const [list, age] = await Promise.all([listParties(db, companyId, type, q), ageing(db, companyId, type, todayIST())]);
  const ageById = new Map(age.parties.map((p) => [p.id, p]));
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
      {age.total.gt(0) && <div className="mt-4">
        <div className="flex h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden>
          {([["old", "bg-ink-3"], ["notDue", "bg-good"], ["d1_30", "bg-warn/60"], ["d31_60", "bg-warn"], ["d61_90", "bg-bad/70"], ["d90", "bg-bad"]] as const).map(([k, c]) =>
            age.buckets[k].gt(0) && <div key={k} className={c} style={{ width: `${age.buckets[k].div(age.total).mul(100).toFixed(2)}%` }} />)}
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-ink-2">
          {age.buckets.old.gt(0) && <li>Old balance (age not known) {formatINRShort(age.buckets.old)}</li>}
          <li>Not yet due {formatINRShort(age.buckets.notDue)}</li><li>1–30 days late {formatINRShort(age.buckets.d1_30)}</li>
          <li>31–60 {formatINRShort(age.buckets.d31_60)}</li><li>61–90 {formatINRShort(age.buckets.d61_90)}</li><li className={age.buckets.d90.gt(0) ? "font-semibold text-bad" : ""}>Over 90 days {formatINRShort(age.buckets.d90)}</li>
        </ul>
        <p className="mt-2 text-ink-2">{age.overdue.gt(0) ? `${formatINRShort(age.overdue)} is ${C ? "overdue — past the credit days you gave" : "overdue to suppliers"}.` : C ? "No bill made in the app is overdue." : "Nothing overdue to suppliers."}
          {age.buckets.old.gt(0) && ` ${formatINRShort(age.buckets.old)} is old balance brought in at setup; its bill dates aren't known, so it's shown separately.`}</p>
      </div>}
    </Card>}

    {C && age.parties.some((p) => p.overdue.gt(0) || p.oldBalance.gt(0)) && <Card className="mb-6">
      <h2 className="text-[18px] font-semibold">Call these first</h2>
      <p className="mb-3 text-[14px] text-ink-2">Ranked by how much is overdue and how late, not just by the biggest amount.</p>
      <ol className="divide-y divide-line">{age.parties.filter((p) => p.overdue.gt(0) || p.oldBalance.gt(0)).slice(0, 7).map((p, i) => {
        const wa = whatsappReminderLink({ whatsapp: p.whatsapp, name: p.name }, businessName, formatINR(p.outstanding));
        return <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><p><span className="mr-2 text-ink-3">{i + 1}.</span><Link href={`${base}/${p.id}`} className="font-medium hover:underline">{p.name}</Link></p>
            <p className="text-[14px] text-ink-2">{[p.overdue.gt(0) && `${formatINR(p.overdue)} overdue, oldest ${p.oldest} days`, p.oldBalance.gt(0) && `${formatINR(p.oldBalance)} old balance`].filter(Boolean).join(" + ")}{p.habit ? ` · usually pays ${p.habit.avgDaysLate > 0 ? `${p.habit.avgDaysLate} days late` : "on time"}` : ""}</p></div>
          <div className="flex gap-2">{p.phone && <a href={`tel:+91${p.phone}`} className="rounded-lg border border-line px-3 py-1.5 text-[14px]">📞 Call</a>}
            {wa && <a href={`${base}/${p.id}#remind`} className="rounded-lg bg-good px-3 py-1.5 text-[14px] text-white">WhatsApp</a>}</div>
        </li>; })}</ol>
    </Card>}

    {!C && (age.overdue.gt(0) || age.parties.some((p) => p.dueSoon.gt(0))) && <Card className="mb-6">
      <h2 className="text-[18px] font-semibold">Payments coming up</h2>
      <ul className="mt-2 divide-y divide-line">{age.parties.filter((p) => p.overdue.gt(0) || p.dueSoon.gt(0)).slice(0, 7).map((p) =>
        <li key={p.id} className="flex justify-between py-2.5"><Link href={`${base}/${p.id}`} className="hover:underline">{p.name}</Link>
          <span className="text-[14px]">{p.overdue.gt(0) && <Status tone="bad">{formatINR(p.overdue)} overdue</Status>} {p.dueSoon.gt(0) && <Status tone="warn">{formatINR(p.dueSoon)} due this week</Status>}</span></li>)}</ul>
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
          const a = ageById.get(p.id);
          return <tr key={p.id} className={`border-t border-line ${!p.isActive ? "opacity-50" : ""}`}>
            <td className="py-2.5"><Link href={`${base}/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
              {a && a.overdue.gt(0) && <span className="ml-2"><Status tone="bad">{a.oldest}d overdue</Status></span>}
              {overLimit && <span className="ml-2"><Status tone="warn">Over credit limit</Status></span>}</td>
            <td className="hidden text-ink-2 sm:table-cell">{p.city}</td>
            <td className="num hidden text-ink-2 sm:table-cell">{p.phone}</td>
            <td className={`num text-right ${p.balance.lt(0) ? "text-info" : ""}`}>{p.balance.isZero() ? "—" : p.balance.lt(0) ? `${formatINR(p.balance.neg())} adv.` : formatINR(p.balance)}</td>
            <td className="hidden text-right text-[14px] text-ink-2 sm:table-cell">{p.lastPayment ? fmtDate(p.lastPayment) : "—"}</td></tr>; })}</tbody>
      </table>}
    </Card>
  </>;
}
