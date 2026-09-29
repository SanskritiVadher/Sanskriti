import { requireContext } from "@/lib/session";
import { db } from "@/db";
import { ledgerHealth } from "@/lib/accounting/reports";
import { Card, PageHeader, Status } from "@/components/ui";

const LATER = ["Inventory matches stock records (Phase 3)", "GST reconciliation (Phase 5)", "Bank reconciliation (Phase 9)"];

export default async function Health() {
  const ctx = await requireContext("reports.financial");
  const checks = await ledgerHealth(db, ctx.company.id);
  const ok = checks.every((c) => c.ok);
  return <>
    <PageHeader title="System health" subtitle="Automatic checks that your books are internally consistent." />
    <Card className="mb-6"><p className="text-[17px]"><Status tone={ok ? "good" : "bad"}>{ok ? "PASS" : "ERROR"}</Status>
      <span className="ml-3">{ok ? "Accounting records are consistent." : "Something needs attention. Share this page with your accountant."}</span></p></Card>
    <Card><ul className="divide-y divide-line">{checks.map((c) => <li key={c.name} className="flex items-start justify-between gap-4 py-3">
      <div><p className="font-medium">{c.name}</p><p className="text-[14px] text-ink-2">{c.detail}</p></div>
      <Status tone={c.ok ? "good" : "bad"}>{c.ok ? "PASS" : "ERROR"}</Status></li>)}
      {LATER.map((l) => <li key={l} className="flex justify-between py-3 text-ink-3"><span>{l}</span><Status tone="neutral">Not built yet</Status></li>)}
    </ul></Card>
  </>;
}
