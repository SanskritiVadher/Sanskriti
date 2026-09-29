import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { parsePeriod, gstr1, gstr3b } from "@/lib/services/gst";
import { stateByCode } from "@/lib/gst/states";
import { formatINR, D } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { Card, PageHeader } from "@/components/ui";
import { PeriodPicker } from "@/components/gst/period-picker";

import type Decimal from "decimal.js";
type T = { taxable: Decimal; igst: Decimal; cgst: Decimal; sgst: Decimal };
const Row = ({ label, t, note }: { label: string; t: T; note?: string }) => <tr className="border-t border-line">
  <td className="py-2">{label}{note && <span className="block text-[12px] text-ink-3">{note}</span>}</td><td className="num text-right">{formatINR(t.taxable)}</td>
  <td className="num text-right">{formatINR(t.igst)}</td><td className="num text-right">{formatINR(t.cgst)}</td><td className="num text-right">{formatINR(t.sgst)}</td></tr>;
const Head = () => <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-2">Section</th><th className="pb-2 text-right">Taxable</th><th className="pb-2 text-right">IGST</th><th className="pb-2 text-right">CGST</th><th className="pb-2 text-right">SGST/UTGST</th></tr></thead>;

export default async function Returns({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const period = (await searchParams).period ?? todayIST().slice(0, 7);
  const per = parsePeriod(period);
  const [r1, r3] = await Promise.all([gstr1(db, ctx.company.id, per), gstr3b(db, ctx.company.id, per)]);
  const z = { taxable: D(0), igst: D(0), cgst: D(0), sgst: D(0) };
  return <>
    <PageHeader title="GST return figures" subtitle={`${per.label} · for filing on the GST portal`} action={<PeriodPicker value={period} action="/gst/returns" />} />
    <Card className="mb-6">
      <h2 className="text-[18px] font-semibold">GSTR-1 (sales)</h2>
      <p className="mb-3 text-[14px] text-ink-2">Upload the JSON in the GST portal&rsquo;s offline tool, or type these totals into the portal directly. Before you submit, check that the portal shows the same totals as this page.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        <a className="rounded-lg bg-brand px-4 py-2.5 text-brand-ink" href={`/gst/export?period=${period}&format=json`}>Download GSTR-1 JSON</a>
        <a className="rounded-lg border border-line bg-surface px-4 py-2.5" href={`/gst/export?period=${period}&format=xlsx`}>Download Excel</a>
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-[14px]"><caption className="sr-only">GSTR-1 summary</caption><Head /><tbody>
        <Row label={`B2B — to registered buyers (${r1.b2b.length} invoices)`} t={r1.totals.b2b} />
        <Row label={`B2C Large — inter-state, unregistered, over ₹1 lakh (${r1.b2cl.length})`} t={r1.totals.b2cl} />
        <Row label="B2C Small — all other unregistered sales (net of their returns)" t={r1.totals.b2cs} />
        <Row label={`Credit notes to registered buyers (${r1.cdnr.length})`} t={r1.totals.cdnr} note="Shown as a reduction" />
        {r1.cdnur.length > 0 && <Row label={`Credit notes, B2C Large (${r1.cdnur.length})`} t={r1.totals.cdnur} note="Shown as a reduction" />}
      </tbody></table></div>
      {r1.b2b.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-brand">B2B invoices</summary>
        <table className="mt-2 w-full text-[13px]"><tbody>{r1.b2b.map((d) => <tr key={d.id} className="border-t border-line"><td className="py-1">{d.number}</td><td>{fmtDate(d.date)}</td><td>{d.name}</td><td className="num">{d.gstin}</td><td className="num text-right">{formatINR(d.total)}</td></tr>)}</tbody></table></details>}
      {(r1.hsnB2B.length + r1.hsnB2C.length) > 0 && <details className="mt-2"><summary className="cursor-pointer text-brand">HSN summary (B2B and B2C separately)</summary>
        {([["B2B", r1.hsnB2B], ["B2C", r1.hsnB2C]] as const).map(([k, rows]) => rows.length > 0 && <table key={k} className="mt-2 w-full text-[13px]"><caption className="text-left font-semibold">{k}</caption><tbody>
          {rows.map((h) => <tr key={h.hsn + h.rate} className="border-t border-line"><td className="py-1">{h.hsn || "— no HSN —"}</td><td>{h.uqc} {h.qty.toString()}</td><td>{h.rate.toString()}%</td><td className="num text-right">{formatINR(h.taxable)}</td><td className="num text-right">{formatINR(h.igst.plus(h.cgst).plus(h.sgst))}</td></tr>)}</tbody></table>)}</details>}
      {r1.docIssue.length > 0 && <p className="mt-3 text-[13px] text-ink-2">Documents issued: {r1.docIssue.map((d) => `${d.nature} ${d.from}–${d.to}: ${d.total} (${d.cancelled} cancelled)`).join("; ")}</p>}
    </Card>

    <Card>
      <h2 className="text-[18px] font-semibold">GSTR-3B (summary)</h2>
      <div className="overflow-x-auto"><table className="mt-3 w-full min-w-[640px] text-[14px]"><caption className="sr-only">GSTR-3B</caption><Head /><tbody>
        <Row label="3.1(a) Outward taxable supplies" t={r3.out} note="Sales minus credit notes" />
        <Row label="4(A)(5) Input tax credit — all other ITC" t={{ ...z, taxable: r3.inp.taxable, igst: r3.inp.igst, cgst: r3.inp.cgst, sgst: r3.inp.sgst }} note="From your purchase bills, minus debit notes. Compare with 2B before claiming." />
      </tbody></table></div>
      {r3.exemptTaxable.gt(0) && <p className="mt-2 text-[13px] text-ink-2">Bills without GST: {formatINR(r3.exemptTaxable)}.</p>}
      {r3.interUnreg.length > 0 && <><h3 className="mt-5 font-semibold">3.2 Inter-state supplies to unregistered persons</h3>
        <ul className="text-[14px]">{r3.interUnreg.map((x) => <li key={x.pos}>{stateByCode(x.pos)?.name ?? x.pos}: taxable {formatINR(x.taxable)}, IGST {formatINR(x.igst)}</li>)}</ul></>}
      <h3 className="mt-5 font-semibold">How the tax gets paid (credit used first, in the legal order)</h3>
      <table className="mt-2 w-full text-[14px]"><caption className="sr-only">Set-off</caption>
        <thead className="text-left text-[12px] text-ink-3"><tr><th className="pb-1" /><th className="pb-1 text-right">IGST</th><th className="pb-1 text-right">CGST</th><th className="pb-1 text-right">SGST</th></tr></thead><tbody>
        <tr className="border-t border-line"><td className="py-1">Tax due</td><td className="num text-right">{formatINR(r3.out.igst)}</td><td className="num text-right">{formatINR(r3.out.cgst)}</td><td className="num text-right">{formatINR(r3.out.sgst)}</td></tr>
        <tr className="border-t border-line"><td className="py-1">Paid by IGST credit</td><td className="num text-right">{formatINR(r3.setoff.used.igst.igst)}</td><td className="num text-right">{formatINR(r3.setoff.used.igst.cgst)}</td><td className="num text-right">{formatINR(r3.setoff.used.igst.sgst)}</td></tr>
        <tr className="border-t border-line"><td className="py-1">Paid by CGST credit</td><td className="num text-right">{formatINR(r3.setoff.used.cgst.igst)}</td><td className="num text-right">{formatINR(r3.setoff.used.cgst.cgst)}</td><td className="text-right text-ink-3">not allowed</td></tr>
        <tr className="border-t border-line"><td className="py-1">Paid by SGST credit</td><td className="num text-right">{formatINR(r3.setoff.used.sgst.igst)}</td><td className="text-right text-ink-3">not allowed</td><td className="num text-right">{formatINR(r3.setoff.used.sgst.sgst)}</td></tr>
        <tr className="border-t-2 border-ink font-semibold"><td className="py-1">Pay in cash</td><td className="num text-right">{formatINR(r3.setoff.cash.igst)}</td><td className="num text-right">{formatINR(r3.setoff.cash.cgst)}</td><td className="num text-right">{formatINR(r3.setoff.cash.sgst)}</td></tr>
      </tbody></table>
      <p className="mt-3 text-[13px] text-ink-3">Credit carried forward: IGST {formatINR(r3.setoff.carryForward.igst)}, CGST {formatINR(r3.setoff.carryForward.cgst)}, SGST {formatINR(r3.setoff.carryForward.sgst)}.
        Late fees, interest, reverse charge and cess are not calculated here. If the portal shows a different amount, first check the 2B match and Items requiring review.</p>
    </Card>
  </>;
}
