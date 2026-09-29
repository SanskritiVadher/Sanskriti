/** A4 GST invoice PDF (pdfkit). Money columns are plain numbers; totals carry a real ₹ sign. */
import PDFDocument from "pdfkit";
import { R, B, RX, BX } from "./fonts";
import { amountInWords } from "@/lib/gst/calc";
import { stateByCode } from "@/lib/gst/states";
import type { getInvoice } from "@/lib/services/sales";

type Inv = NonNullable<Awaited<ReturnType<typeof getInvoice>>>;
const n2 = (v: string | number) => {
  const [i, f] = Number(v).toFixed(2).split(".");
  const neg = i.startsWith("-"); const x = neg ? i.slice(1) : i;
  const last3 = x.slice(-3), rest = x.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${rest ? rest + "," + last3 : last3}.${f}`;
};
const fmtD = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

export async function invoicePdf({ inv, lines, company, bank }: Inv): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 36, info: { Title: `Invoice ${inv.number}`, Author: company.name } });
  doc.registerFont("R", Buffer.from(R, "base64")); doc.registerFont("B", Buffer.from(B, "base64"));
  doc.registerFont("RX", Buffer.from(RX, "base64")); doc.registerFont("BX", Buffer.from(BX, "base64"));
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 72, L = 36;
  const ink = "#1d1f1c", mute = "#6b6f67", line = "#d9d7cf";

  /** Right-aligned "₹ 1,23,456.00" with the rupee glyph from the latin-ext subset. */
  const rupee = (amount: string, right: number, y: number, bold = false, size = 10) => {
    const f = bold ? "B" : "R", fx = bold ? "BX" : "RX";
    const neg = Number(amount) < 0;
    const txt = n2(Math.abs(Number(amount)));
    doc.font(f).fontSize(size); const w = doc.widthOfString(txt); const sw = neg ? doc.widthOfString("− ") : 0;
    doc.font(fx).fontSize(size); const rw = doc.widthOfString("₹");
    if (neg) doc.font(f).fillColor(ink).text("− ", right - w - rw - sw, y, { lineBreak: false });
    doc.font(fx).fillColor(ink).text("₹", right - w - rw, y, { lineBreak: false });
    doc.font(f).fillColor(ink).text(txt, right - w, y, { lineBreak: false });
  };

  // Header
  doc.fillColor(ink).font("B").fontSize(16).text(company.name, L, 36, { width: W * 0.6 });
  doc.font("R").fontSize(9).fillColor(mute);
  const addr = [company.addressLine1, company.addressLine2, [company.city, company.pincode].filter(Boolean).join(" "), stateByCode(company.stateCode)?.name].filter(Boolean).join(", ");
  if (addr) doc.text(addr, { width: W * 0.6 });
  if (company.gstin) doc.text(`GSTIN: ${company.gstin}`);
  if (company.phone) doc.text(`Phone: ${company.phone}`);
  const title = inv.docType === "TAX_INVOICE" ? "TAX INVOICE" : "BILL OF SUPPLY";
  doc.font("B").fontSize(13).fillColor(ink).text(title, L, 36, { width: W, align: "right" });
  doc.font("R").fontSize(9).fillColor(mute).text("Original for recipient", L, 54, { width: W, align: "right" });

  let y = Math.max(doc.y, 100) + 10;
  doc.moveTo(L, y).lineTo(L + W, y).strokeColor(line).stroke(); y += 10;
  // Meta + Bill to
  doc.font("B").fontSize(9).fillColor(mute).text("BILL TO", L, y);
  doc.font("B").fontSize(11).fillColor(ink).text(inv.customerName, L, y + 12, { width: W * 0.55 });
  doc.font("R").fontSize(9).fillColor(mute);
  if (inv.customerAddress) doc.text(inv.customerAddress, { width: W * 0.55 });
  if (inv.customerGstin) doc.text(`GSTIN: ${inv.customerGstin}`);
  if (inv.customerPhone) doc.text(`Phone: ${inv.customerPhone}`);
  const leftBottom = doc.y;
  const meta: [string, string][] = [["Invoice no.", inv.number], ["Date", fmtD(inv.invoiceDate)], ["Due date", fmtD(inv.dueDate)],
    ["Place of supply", `${stateByCode(inv.placeOfSupply)?.name ?? "—"}${inv.placeOfSupply ? ` (${inv.placeOfSupply})` : ""}`]];
  meta.forEach(([k, v], i) => {
    doc.font("R").fontSize(9).fillColor(mute).text(k, L + W * 0.6, y + i * 14, { width: 80 });
    doc.font("B").fillColor(ink).text(v, L + W * 0.6 + 80, y + i * 14, { width: W * 0.4 - 80, align: "right" });
  });
  y = Math.max(leftBottom, y + meta.length * 14) + 14;

  // Items table
  const intra = inv.supplyType === "INTRA", none = inv.supplyType === "NONE";
  const cols = none
    ? [["#", 18, "l"], ["Item", 210, "l"], ["HSN", 50, "l"], ["Qty", 50, "r"], ["Rate", 65, "r"], ["Disc%", 40, "r"], ["Amount", 90, "r"]] as const
    : [["#", 16, "l"], ["Item", 128, "l"], ["HSN", 42, "l"], ["Qty", 40, "r"], ["Rate", 58, "r"], ["Disc%", 32, "r"], ["Taxable", 64, "r"], ["GST%", 30, "r"], ["Tax", 56, "r"], ["Total", 66, "r"]] as const;
  const widths = cols.map((c) => c[1] as number); const scale = W / widths.reduce((a, b) => a + b, 0);
  const xs: number[] = []; let acc = L; for (const w of widths) { xs.push(acc); acc += w * scale; }
  const header = () => {
    doc.rect(L, y, W, 18).fill("#f0efe9");
    cols.forEach((c, i) => doc.font("B").fontSize(8).fillColor(mute).text(c[0], xs[i] + 3, y + 5, { width: widths[i] * scale - 6, align: c[2] === "r" ? "right" : "left" }));
    y += 22;
  };
  header();
  lines.forEach((l, idx) => {
    const tax = Number(l.cgst) + Number(l.sgst) + Number(l.igst);
    const vals = none
      ? [String(idx + 1), l.description + (l.serials ? `\nS/N: ${l.serials}` : ""), l.hsn ?? "", `${Number(l.quantity)} ${l.unit}`, n2(l.rate), Number(l.discountPct) ? String(Number(l.discountPct)) : "", n2(l.taxable)]
      : [String(idx + 1), l.description + (l.serials ? `\nS/N: ${l.serials}` : ""), l.hsn ?? "", `${Number(l.quantity)} ${l.unit}`, n2(l.rate), Number(l.discountPct) ? String(Number(l.discountPct)) : "", n2(l.taxable), String(Number(l.gstRate)), n2(tax), n2(l.lineTotal)];
    doc.font("R").fontSize(9);
    const h = Math.max(...vals.map((v, i) => doc.heightOfString(v, { width: widths[i] * scale - 6 }))) + 8;
    if (y + h > doc.page.height - 200) { doc.addPage(); y = 40; header(); }
    vals.forEach((v, i) => doc.font(i === 1 ? "B" : "R").fontSize(9).fillColor(ink).text(v, xs[i] + 3, y, { width: widths[i] * scale - 6, align: cols[i][2] === "r" ? "right" : "left" }));
    y += h; doc.moveTo(L, y - 3).lineTo(L + W, y - 3).strokeColor(line).stroke();
  });

  // Totals
  if (y > doc.page.height - 220) { doc.addPage(); y = 40; }
  y += 8;
  const right = L + W, labelX = L + W * 0.55;
  const row = (label: string, amount: string, bold = false) => {
    doc.font(bold ? "B" : "R").fontSize(bold ? 11 : 9.5).fillColor(bold ? ink : mute).text(label, labelX, y, { width: 150 });
    rupee(amount, right, y, bold, bold ? 11 : 9.5); y += bold ? 20 : 15;
  };
  if (Number(inv.discount)) { row("Amount before discount", inv.subtotal); row("Discount", String(-Number(inv.discount))); }
  row(none ? "Amount" : "Taxable value", inv.taxable);
  if (!none && intra) { row("CGST", inv.cgst); row(stateByCode(inv.placeOfSupply)?.utgst ? "UTGST" : "SGST", inv.sgst); }
  if (!none && !intra) row("IGST", inv.igst);
  if (Number(inv.roundOff)) row("Round off", inv.roundOff);
  doc.moveTo(labelX, y).lineTo(right, y).strokeColor(ink).stroke(); y += 6;
  row("Grand total", inv.total, true);
  if (Number(inv.paidAtSale)) { row("Paid", inv.paidAtSale); row("Balance due", String(Number(inv.total) - Number(inv.paidAtSale)), true); }
  const wordsY = y + 4;
  doc.font("R").fontSize(9).fillColor(mute).text("Amount in words", L, wordsY);
  doc.font("B").fillColor(ink).text(amountInWords(inv.total), L, wordsY + 12, { width: W });
  y = doc.y + 14;
  if (bank) {
    doc.font("R").fontSize(9).fillColor(mute).text("Bank details", L, y);
    doc.fillColor(ink).text([bank.bankName, bank.accountHolder, bank.accountNumberLast4 && `A/c ending ${bank.accountNumberLast4}`, bank.ifsc && `IFSC ${bank.ifsc}`].filter(Boolean).join(" · "), L, y + 12, { width: W * 0.6 });
    y = doc.y + 10;
  }
  if (inv.notes) { doc.font("R").fontSize(9).fillColor(mute).text(`Note: ${inv.notes}`, L, y, { width: W }); y = doc.y + 10; }
  doc.font("R").fontSize(8).fillColor(mute).text(`Payment due by ${fmtD(inv.dueDate)}. This is a computer-generated invoice.`, L, doc.page.height - 70, { width: W * 0.6 });
  doc.font("B").fontSize(9).fillColor(ink).text(`For ${company.name}`, L + W * 0.6, doc.page.height - 90, { width: W * 0.4, align: "right" });
  doc.font("R").fontSize(8).fillColor(mute).text("Authorised signatory", L + W * 0.6, doc.page.height - 58, { width: W * 0.4, align: "right" });

  if (inv.status === "CANCELLED") {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.font("B").fontSize(80).fillColor("#b3261e").opacity(0.18).text("CANCELLED", 60, doc.page.height / 2 - 40, { width: doc.page.width - 120, align: "center" });
    doc.restore();
  }
  doc.end();
  return done;
}
