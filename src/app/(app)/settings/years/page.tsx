import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { listPeriods } from "@/lib/services/periods";
import { fmtDate, todayIST } from "@/lib/dates";
import { Button, Card, Input, Notice, PageHeader, Status } from "@/components/ui";
import { periodLockAction } from "@/app/actions-phase6";

export default async function Years({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const ctx = await requireContext("company.edit");
  const sp = await searchParams;
  const list = await listPeriods(db, ctx.company.id);
  const today = todayIST();
  return <>
    <PageHeader title="Financial years" subtitle="Once a year is finished and its returns are filed, lock it so nothing in it can be changed by mistake. You can reopen it later if needed." />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Saved." /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card><ul className="divide-y divide-line">{list.map((p) => <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div><p className="font-medium">{p.name}</p><p className="text-[14px] text-ink-2">{fmtDate(p.startDate)} – {fmtDate(p.endDate)}</p></div>
      <div className="flex items-center gap-3">{p.isClosed ? <Status tone="neutral">Locked</Status> : p.endDate < today ? <Status tone="warn">Open</Status> : <Status tone="info">Current year</Status>}
        {(p.isClosed ? ctx.role === "OWNER" : p.endDate < today) && <form action={periodLockAction} className="flex items-center gap-2">
          <input type="hidden" name="id" value={p.id} /><input type="hidden" name="lock" value={p.isClosed ? "0" : "1"} />
          <Input name="reason" required placeholder={p.isClosed ? "Why reopen?" : "e.g. Returns filed, books checked"} className="!w-56 !py-1.5" />
          <Button variant="secondary" className="!py-1.5">{p.isClosed ? "Reopen" : "Lock year"}</Button></form>}</div>
    </li>)}</ul></Card>
  </>;
}
