import { stateByCode } from "@/lib/gst/states";
import { amountInWords } from "@/lib/gst/calc";
import { formatINR, D } from "@/lib/money";
import { fmtDate } from "@/lib/dates";
import type { getInvoice } from "@/lib/services/sales";

type Inv = NonNullable<Awaited<ReturnType<typeof getInvoice>>>;
/** On-screen / printable invoice. Same figures as the PDF (both read the stored invoice). */
export function InvoiceView({ inv, lines, company, bank }: Inv) {
  const intra = inv.supplyType === "INTRA", none = inv.supplyType === "NONE";
  return <article className="relative rounded-2xl border border-line bg-surface p-6 text-[14px] print:border-0 print:p-0">
    {inv.status === "CANCELLED" && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[64px] font-bold text-bad opacity-15 -rotate-12">CANCELLED</div>}
    <header className="flex flex-wrap justify-between gap-4 border-b border-line pb-4">
      <div><p className="text-[20px] font-semibold">{company.name}</p>
        <p className="text-ink-2">{[company.addressLine1, company.city, company.pincode, stateByCode(company.stateCode)?.name].filter(Boolean).join(", ")}</p>
        {company.gstin && <p className="text-ink-2">GSTIN: {company.gstin}</p>}{company.phone && <p className="text-ink-2">Phone: {company.phone}</p>}</div>
      <div className="text-right"><p className="text-[18px] font-semibold">{inv.docType === "TAX_INVOICE" ? "TAX INVOICE" : "BILL OF SUPPLY"}</p>
        <dl className="mt-1 grid grid-cols-2 gap-x-4 text-ink-2"><dt>Invoice no.</dt><dd className="font-semibold text-ink">{inv.number}</dd>
          <dt>Date</dt><dd className="text-ink">{fmtDate(inv.invoiceDate)}</dd><dt>Due date</dt><dd className="text-ink">{fmtDate(inv.dueDate)}</dd>
          <dt>Place of supply</dt><dd className="text-ink">{stateByCode(inv.placeOfSupply)?.name ?? "—"}</dd></dl></div>
    </header>
    <section className="py-4"><p className="text-[12px] font-semibold text-ink-3">BILL TO</p><p className="text-[16px] font-semibold">{inv.customerName}</p>
      {inv.customerAddress && <p className="text-ink-2">{inv.customerAddress}</p>}{inv.customerGstin && <p className="text-ink-2">GSTIN: {inv.customerGstin}</p>}</section>
    <div className="overflow-x-auto"><table className="w-full min-w-[600px]"><caption className="sr-only">Items</caption>
      <thead className="bg-surface-2 text-left text-[12px] text-ink-3"><tr><th className="p-2">#</th><th className="p-2">Item</th><th className="p-2">HSN</th><th className="p-2 text-right">Qty</th>
        <th className="p-2 text-right">Rate</th><th className="p-2 text-right">Disc%</th><th className="p-2 text-right">Taxable</th>{!none && <><th className="p-2 text-right">GST%</th><th className="p-2 text-right">Tax</th></>}<th className="p-2 text-right">Total</th></tr></thead>
      <tbody>{lines.map((l) => <tr key={l.id} className="border-b border-line align-top">
        <td className="p-2">{l.lineNo}</td><td className="p-2 font-medium">{l.description}{l.serials && <span className="block text-[12px] font-normal text-ink-3">S/N: {l.serials}</span>}</td>
        <td className="p-2">{l.hsn}</td><td className="num p-2 text-right">{D(l.quantity).toString()} {l.unit}</td><td className="num p-2 text-right">{formatINR(l.rate)}</td>
        <td className="num p-2 text-right">{Number(l.discountPct) ? D(l.discountPct).toString() : ""}</td><td className="num p-2 text-right">{formatINR(l.taxable)}</td>
        {!none && <><td className="num p-2 text-right">{D(l.gstRate).toString()}</td><td className="num p-2 text-right">{formatINR(D(l.cgst).plus(l.sgst).plus(l.igst))}</td></>}
        <td className="num p-2 text-right">{formatINR(l.lineTotal)}</td></tr>)}</tbody>
    </table></div>
    <div className="mt-4 flex flex-wrap justify-between gap-6">
      <div className="max-w-md text-ink-2"><p className="text-[12px]">Amount in words</p><p className="font-semibold text-ink">{amountInWords(inv.total)}</p>
        {bank && <p className="mt-3">Bank: {[bank.bankName, bank.accountNumberLast4 && `A/c ending ${bank.accountNumberLast4}`, bank.ifsc && `IFSC ${bank.ifsc}`].filter(Boolean).join(" · ")}</p>}
        {inv.notes && <p className="mt-2">Note: {inv.notes}</p>}</div>
      <dl className="min-w-64 space-y-1">
        {Number(inv.discount) > 0 && <div className="flex justify-between text-ink-2"><dt>Discount</dt><dd className="num">−{formatINR(inv.discount)}</dd></div>}
        <div className="flex justify-between"><dt>{none ? "Amount" : "Taxable value"}</dt><dd className="num">{formatINR(inv.taxable)}</dd></div>
        {!none && intra && <><div className="flex justify-between text-ink-2"><dt>CGST</dt><dd className="num">{formatINR(inv.cgst)}</dd></div>
          <div className="flex justify-between text-ink-2"><dt>{stateByCode(inv.placeOfSupply)?.utgst ? "UTGST" : "SGST"}</dt><dd className="num">{formatINR(inv.sgst)}</dd></div></>}
        {!none && !intra && <div className="flex justify-between text-ink-2"><dt>IGST</dt><dd className="num">{formatINR(inv.igst)}</dd></div>}
        {Number(inv.roundOff) !== 0 && <div className="flex justify-between text-ink-3"><dt>Round off</dt><dd className="num">{formatINR(inv.roundOff)}</dd></div>}
        <div className="flex justify-between border-t border-ink pt-1 text-[18px] font-semibold"><dt>Grand total</dt><dd className="num">{formatINR(inv.total)}</dd></div>
      </dl>
    </div>
  </article>;
}
