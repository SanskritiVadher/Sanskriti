import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { billFormOptions } from "@/lib/services/form-options";
import { todayIST } from "@/lib/dates";
import { PageHeader, Notice } from "@/components/ui";
import { BillForm } from "@/components/docs/bill-form";
import { saveSaleAction } from "@/app/actions-phase4";
import { sql } from "drizzle-orm";

export default async function NewSale() {
  const ctx = await requireContext("sales.create");
  const o = await billFormOptions(ctx.company.id, "CUSTOMER");
  // Last rate charged per customer per product, so repeat customers get consistent prices.
  const r = await db.execute<{ party_id: string; product_id: string; rate: string }>(sql`
    SELECT DISTINCT ON (i.party_id, l.product_id) i.party_id, l.product_id, l.rate FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
    WHERE i.company_id = ${ctx.company.id} AND i.status = 'ACTIVE' ORDER BY i.party_id, l.product_id, i.invoice_date DESC, i.created_at DESC`);
  const last: Record<string, Record<string, string>> = {};
  for (const x of r.rows) (last[x.party_id] ??= {})[x.product_id] = x.rate;
  return <>
    <PageHeader title="New bill" subtitle="Choose customer, add products. GST is worked out for you." />
    {!o.productOpts.length && <div className="mb-4"><Notice tone="warn" title="Add products (or import them from Tally) before billing." /></div>}
    <BillForm mode="sale" action={saveSaleAction} parties={o.partyOpts} products={o.productOpts} cashBank={o.cashBank}
      company={{ state: ctx.company.stateCode, registration: ctx.company.gstRegistration }} today={todayIST()} lastRates={last} />
  </>;
}
