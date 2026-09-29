import { notFound } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { getBill } from "@/lib/services/purchases";
import { PageHeader } from "@/components/ui";
import { ReturnForm } from "@/components/docs/return-form";
import { debitNoteAction } from "@/app/actions-phase5";

export default async function BuyReturn({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireContext("purchases.create");
  const { id } = await params;
  const d = await getBill(db, ctx.company.id, id);
  if (!d) notFound();
  return <><PageHeader title={`Return to supplier: bill ${d.b.billNumber}`} subtitle={`${d.party.name} · creates a GST debit note`} />
    <ReturnForm kind="DEBIT_NOTE" docId={id} action={debitNoteAction} error={(await searchParams).error} idName="billId" /></>;
}
