import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { getContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { parsePeriod, gstr1, gstr1Json } from "@/lib/services/gst";
import { audit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  const ctx = await getContext();
  if (!ctx || !can(ctx.role, "exports")) return new NextResponse("Not allowed", { status: 403 });
  const u = new URL(req.url);
  const per = parsePeriod(u.searchParams.get("period") ?? "");
  const r = await gstr1(db, ctx.company.id, per);
  await audit(db, { companyId: ctx.company.id, userId: ctx.user.id, action: "export.gstr1", entityType: "gst", entityId: per.fp, after: { format: u.searchParams.get("format") } });
  if (u.searchParams.get("format") !== "xlsx")
    return new NextResponse(JSON.stringify(gstr1Json(r), null, 1), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="GSTR1_${r.company.gstin ?? "NA"}_${per.fp}.json"` } });
  const wb = new ExcelJS.Workbook();
  const sheet = (name: string, cols: string[], rows: (string | number)[][]) => { const ws = wb.addWorksheet(name); ws.addRow(cols).font = { bold: true }; rows.forEach((x) => ws.addRow(x)); ws.columns.forEach((c) => (c.width = 18)); };
  const n = (d: { toFixed(n: number): string }) => Number(d.toFixed(2));
  const perLine = (ds: typeof r.b2b) => ds.flatMap((d) => d.lines.map((l) => [d.gstin ?? "", d.name, d.number, d.date, n(d.total), d.pos ?? "", n(l.rate), n(l.taxable), n(l.igst), n(l.cgst), n(l.sgst)]));
  const hdr = ["GSTIN", "Name", "Number", "Date", "Invoice value", "Place of supply", "Rate", "Taxable", "IGST", "CGST", "SGST"];
  sheet("b2b", hdr, perLine(r.b2b));
  sheet("b2cl", hdr, perLine(r.b2cl));
  sheet("b2cs", ["Type", "Place of supply", "Rate", "Taxable", "IGST", "CGST", "SGST"], r.b2cs.map((x) => [x.type, x.pos, n(x.rate), n(x.taxable), n(x.igst), n(x.cgst), n(x.sgst)]));
  sheet("cdnr", ["GSTIN", "Name", "Note no.", "Note date", "Against invoice", "Rate", "Taxable", "IGST", "CGST", "SGST"], r.cdnr.flatMap((c) => c.lines.map((l) => [c.gstin ?? "", c.name, c.number, c.date, c.invNumber, n(l.rate), n(l.taxable), n(l.igst), n(l.cgst), n(l.sgst)])));
  const hsnRows = (k: string, rows: typeof r.hsnB2B) => rows.map((h) => [k, h.hsn, h.desc, h.uqc, n(h.qty), n(h.rate), n(h.taxable), n(h.igst), n(h.cgst), n(h.sgst)]);
  sheet("hsn", ["B2B/B2C", "HSN", "Description", "UQC", "Qty", "Rate", "Taxable", "IGST", "CGST", "SGST"], [...hsnRows("B2B", r.hsnB2B), ...hsnRows("B2C", r.hsnB2C)]);
  sheet("docs", ["Nature", "From", "To", "Total", "Cancelled"], r.docIssue.map((d) => [d.nature, d.from ?? "", d.to ?? "", d.total, d.cancelled]));
  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buf as ArrayBuffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="GSTR1_${per.fp}.xlsx"` } });
}
