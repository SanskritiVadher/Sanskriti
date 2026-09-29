import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { db } from "@/db";
import { getInvoice } from "@/lib/services/sales";
import { InvoiceView } from "@/components/docs/invoice-view";

export const metadata: Metadata = { robots: { index: false, follow: false } };
/** Public, read-only view of ONE invoice, reached only via its unguessable link. No login. */
export default async function SharedInvoice({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) notFound();
  const d = await getInvoice(db, { token });
  if (!d) notFound();
  return <main className="mx-auto max-w-4xl px-4 py-8">
    <div className="mb-4 flex justify-end gap-2 print:hidden">
      <a href={`/i/${token}/pdf`} className="rounded-lg bg-brand px-4 py-2.5 text-[15px] text-brand-ink">Download PDF</a>
    </div>
    <InvoiceView {...d} />
  </main>;
}
