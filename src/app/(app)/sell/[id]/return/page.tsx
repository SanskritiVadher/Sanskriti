import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { ReturnForm } from "@/components/docs/return-form";
import { creditNoteAction } from "@/app/actions-phase5";

export default async function SaleReturn({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireContext("sales.create");
  const { id } = await params;
  const inv = await db.query.salesInvoices.findFirst({ where: and(eq(schema.salesInvoices.id, id), eq(schema.salesInvoices.companyId, ctx.company.id)) });
  if (!inv) notFound();
  return <><PageHeader title={`Goods returned: ${inv.number}`} subtitle={`${inv.customerName} · creates a GST credit note`} />
    <ReturnForm kind="CREDIT_NOTE" docId={id} action={creditNoteAction} error={(await searchParams).error} idName="invoiceId" /></>;
}
