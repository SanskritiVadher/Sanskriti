import { requireContext } from "@/lib/session";
import { Card, Notice, PageHeader } from "@/components/ui";
import { OpeningForm } from "@/components/opening-form";

export default async function Opening({ searchParams }: { searchParams: Promise<{ saved?: string; error?: string }> }) {
  const ctx = await requireContext("ledger.post_manual");
  const sp = await searchParams;
  return <>
    <PageHeader title="Opening balances" subtitle="What the business had on the day you start using this app." />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Opening balances saved." /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <Card><OpeningForm companyId={ctx.company.id} back="settings" /></Card>
  </>;
}
