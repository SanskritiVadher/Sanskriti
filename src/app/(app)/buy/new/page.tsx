import { requireContext } from "@/lib/session";
import { billFormOptions } from "@/lib/services/form-options";
import { todayIST } from "@/lib/dates";
import { PageHeader } from "@/components/ui";
import { BillForm } from "@/components/docs/bill-form";
import { saveBillAction } from "@/app/actions-phase4";

export default async function NewPurchase() {
  const ctx = await requireContext("purchases.create");
  const o = await billFormOptions(ctx.company.id, "SUPPLIER");
  return <>
    <PageHeader title="Record a purchase" subtitle="Copy the supplier's bill. Stock, GST and what you owe update automatically." />
    <BillForm mode="purchase" action={saveBillAction} parties={o.partyOpts} products={o.productOpts} cashBank={o.cashBank}
      company={{ state: ctx.company.stateCode, registration: ctx.company.gstRegistration }} today={todayIST()} />
  </>;
}
