import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { todayIST, fyStart, fmtDate } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { Button, Card, Field, Input, PageHeader } from "@/components/ui";
import { PartyForm } from "@/components/parties/form";
import { partyOpeningAction } from "@/app/actions-phase3";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext("purchases.create");
  const { id } = await params;
  const p = await db.query.parties.findFirst({ where: and(eq(schema.parties.id, id), eq(schema.parties.companyId, ctx.company.id)) });
  if (!p) notFound();
  const opening = await db.query.journalEntries.findFirst({ where: and(eq(schema.journalEntries.companyId, ctx.company.id),
    eq(schema.journalEntries.sourceType, "opening_party"), eq(schema.journalEntries.sourceId, id), eq(schema.journalEntries.status, "POSTED")) });
  return <>
    <PageHeader title={`Edit ${p.name}`} />
    <PartyForm type="SUPPLIER" party={p as never} sp={await searchParams} />
    {can(ctx.role, "ledger.post_manual") && <Card className="mt-6">
      <h2 className="text-[17px] font-semibold">Old balance</h2>
      <p className="mb-4 text-[14px] text-ink-2">{opening ? `Currently recorded: ${formatINR(opening.totalAmount)} as on ${fmtDate(opening.entryDate)}. ` : "None recorded. "}
        Saving replaces it; the old figure is cancelled, not deleted.</p>
      <form action={partyOpeningAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="id" value={p.id} /><input type="hidden" name="type" value="SUPPLIER" />
        <Field label="Amount you owed them (₹)"><Input name="openingBalance" inputMode="decimal" placeholder="0" /></Field>
        <Field label="As on"><Input type="date" name="openingDate" defaultValue={opening?.entryDate ?? fyStart(todayIST())} /></Field>
        <Button variant="secondary">Update old balance</Button>
      </form>
    </Card>}
  </>;
}
