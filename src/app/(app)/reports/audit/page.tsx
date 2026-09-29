import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { auditLog, diff } from "@/lib/services/audit-read";
import { Button, Card, Input, PageHeader, Status } from "@/components/ui";

const LABEL: Record<string, string> = { "ledger.post": "Entry recorded", "ledger.reverse": "Entry cancelled", "sale.create": "Bill made", "sale.cancel": "Bill cancelled",
  "purchase.create": "Purchase recorded", "purchase.cancel": "Purchase cancelled", "credit_note.create": "Customer return", "debit_note.create": "Return to supplier",
  "company.update": "Business details changed", "company.gst_update": "GST details changed", "user.login": "Logged in", "user.create": "Team member added",
  "user.password_reset": "Password reset", "product.update": "Product changed", "product.create": "Product added", "party.update": "Customer/supplier changed",
  "stock.adjust": "Stock corrected", "gst.payment": "GST payment recorded", "period.lock": "Year locked", "period.unlock": "Year reopened", "settings.ratio_targets": "Ratio targets changed", "settings.reorder": "Reorder settings changed", "assist.quick_entry": "Quick entry saved", "check.ok": "Unusual item marked checked", "bank.import": "Bank statement uploaded", "backup.download": "Backup downloaded", "gst.strict_on": "Turned on: only bill checked GST rates", "gst.strict_off": "Turned off: only bill checked GST rates", "product.gst_confirm": "GST rate confirmed", "user.logout_all": "Logged out everywhere", "bank.match": "Bank line matched", "bank.ignore": "Bank line left out", "bank.unmatch": "Bank match undone", "export.gstr1": "GSTR-1 downloaded", "export.statements": "Financial statements downloaded", "import.customers": "Customers imported",
  "import.suppliers": "Suppliers imported", "import.products": "Products imported", "gstr2b.import": "GSTR-2B uploaded", "bank.create": "Bank account added", "brand.create": "Brand added",
  "company.create": "Business created", "user.password_change": "Password changed", "gst_rule.create": "GST rate added", "gst_rule.confirm": "GST rate confirmed" };
const show = (v: unknown) => (v == null ? "—" : typeof v === "object" ? JSON.stringify(v).slice(0, 80) : String(v));

export default async function Audit({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; q?: string; page?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const sp = await searchParams;
  const r = await auditLog(db, ctx.company.id, { from: sp.from, to: sp.to, q: sp.q, page: Number(sp.page) || 1 });
  const qs = (page: number) => `?${new URLSearchParams({ ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}), ...(sp.q ? { q: sp.q } : {}), page: String(page) })}`;
  return <>
    <PageHeader title="Who did what" subtitle="Every change is recorded: who, when, what it was before and after. Records can't be edited or deleted." />
    <form className="mb-4 flex flex-wrap items-end gap-2">
      <label className="text-[14px]">From<Input type="date" name="from" defaultValue={sp.from} className="mt-1" /></label>
      <label className="text-[14px]">To<Input type="date" name="to" defaultValue={sp.to} className="mt-1" /></label>
      <label className="text-[14px]">Type<Input name="q" defaultValue={sp.q} placeholder="e.g. sale, stock, login" className="mt-1" /></label>
      <Button variant="secondary">Filter</Button>
    </form>
    <Card className="overflow-x-auto"><p className="mb-2 text-[13px] text-ink-3">{r.total} records</p>
      <table className="w-full min-w-[720px] text-[14px]"><caption className="sr-only">Audit trail</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">When</th><th className="pb-2">Who</th><th className="pb-2">What</th><th className="pb-2">Details</th></tr></thead>
        <tbody>{r.rows.map(({ a, user }) => { const d = diff(a.before, a.after);
          return <tr key={a.id} className="border-t border-line align-top">
            <td className="whitespace-nowrap py-2">{a.createdAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</td>
            <td>{user ?? "System"}{a.source !== "app" && <span className="ml-1"><Status tone="info">{a.source}</Status></span>}</td>
            <td>{LABEL[a.action] ?? a.action}{a.entityType === "journal_entry" && a.entityId && <Link className="ml-2 text-brand underline" href={`/reports/entry/${a.entityId}`}>open</Link>}</td>
            <td className="text-ink-2">{a.reason && <p>Reason: {a.reason}</p>}
              {a.before != null && d.length > 0 && <ul>{d.slice(0, 5).map((x) => <li key={x.field}><b>{x.field}</b>: {show(x.from)} → {show(x.to)}</li>)}</ul>}
              {a.before == null && a.after != null && <p className="text-[12px]">{show(a.after)}</p>}</td></tr>; })}</tbody></table>
      <div className="mt-3 flex gap-3 text-[14px]">{r.page > 1 && <Link className="text-brand underline" href={qs(r.page - 1)}>← Newer</Link>}{r.more && <Link className="text-brand underline" href={qs(r.page + 1)}>Older →</Link>}</div>
    </Card>
  </>;
}
