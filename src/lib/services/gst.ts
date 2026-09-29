/**
 * GST returns, computed only from stored invoices, bills and notes (never re-derived from product data).
 * Free route: the app prepares GSTR-1 in the portal's JSON upload format + an Excel copy; GSTR-2B is
 * downloaded by the owner from the portal and uploaded here for matching.
 * Rules encoded here (GST rules change; review when notifications change):
 *  - B2CL: inter-state invoice to an unregistered buyer with invoice value > ₹1,00,000 (Notification 12/2024, from 1 Aug 2024)
 *  - HSN summary (Table 12) reported separately for B2B and B2C (from 2025)
 *  - ITC set-off order (Sec 49 / Rule 88A): IGST credit first (IGST → CGST/SGST), then CGST (CGST → IGST), SGST (SGST → IGST).
 *    CGST credit can never pay SGST and vice versa.
 */
import { and, eq, gte, lte, sql, desc } from "drizzle-orm";
import Decimal from "decimal.js";
import { schema, type DB, type Tx } from "@/db";
import { D, toDb, formatINR } from "@/lib/money";
import { UserFacingError } from "@/lib/errors";
import { postEntryTx, type LineInput } from "@/lib/accounting/engine";
import { audit } from "./audit";

export const B2CL_LIMIT = D(100000);
export type Period = { from: string; to: string; label: string; fp: string };

/** "2026-09" → Sep 2026; "2026-Q2" → Jul–Sep 2026 (Indian FY quarters: Q1 Apr–Jun … Q4 Jan–Mar). */
export function parsePeriod(p: string): Period {
  const m = p.match(/^(\d{4})-(\d{2})$/);
  const endOf = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  const name = (y: number, mo: number) => new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
  if (m) { const y = +m[1], mo = +m[2]; return { from: `${m[1]}-${m[2]}-01`, to: endOf(y, mo), label: name(y, mo), fp: `${m[2]}${m[1]}` }; }
  const q = p.match(/^(\d{4})-Q([1-4])$/);
  if (q) {
    const fy = +q[1], n = +q[2]; const startMonth = [4, 7, 10, 1][n - 1]; const y = n === 4 ? fy + 1 : fy; const endMonth = startMonth + 2;
    return { from: `${y}-${String(startMonth).padStart(2, "0")}-01`, to: endOf(y, endMonth), label: `${name(y, startMonth)} – ${name(y, endMonth)}`, fp: `${String(endMonth).padStart(2, "0")}${y}` };
  }
  throw new UserFacingError("Choose a valid month or quarter.");
}
const ddmmyyyy = (d: string) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}`;
const UQC: Record<string, string> = { pcs: "PCS", nos: "NOS", no: "NOS", kg: "KGS", kgs: "KGS", box: "BOX", set: "SET", sets: "SET", pair: "PRS", mtr: "MTR", m: "MTR", ltr: "LTR", l: "LTR" };
const n2 = (d: Decimal.Value) => Number(D(d).toFixed(2));

type Line = { hsn: string | null; unit: string; desc: string; qty: Decimal; taxable: Decimal; rate: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal };
type Doc = { id: string; number: string; date: string; gstin: string | null; name: string; pos: string | null; type: "INTRA" | "INTER" | "NONE"; total: Decimal; lines: Line[] };

async function outward(db: DB, companyId: string, per: Period) {
  const invs = await db.query.salesInvoices.findMany({ where: and(eq(schema.salesInvoices.companyId, companyId), eq(schema.salesInvoices.status, "ACTIVE"),
    gte(schema.salesInvoices.invoiceDate, per.from), lte(schema.salesInvoices.invoiceDate, per.to)), orderBy: schema.salesInvoices.invoiceDate });
  const allLines = invs.length ? await db.execute<{ invoice_id: string; hsn: string | null; unit: string; description: string; quantity: string; taxable: string; gst_rate: string; cgst: string; sgst: string; igst: string }>(sql`
    SELECT invoice_id, hsn, unit, description, quantity, taxable, gst_rate, cgst, sgst, igst FROM sales_invoice_lines WHERE invoice_id IN (SELECT id FROM sales_invoices WHERE company_id = ${companyId} AND status = 'ACTIVE' AND invoice_date BETWEEN ${per.from} AND ${per.to})`) : { rows: [] };
  const mkLine = (l: { hsn: string | null; unit: string; description: string; quantity: string; taxable: string; gst_rate: string; cgst: string; sgst: string; igst: string }): Line =>
    ({ hsn: l.hsn, unit: l.unit, desc: l.description, qty: D(l.quantity), taxable: D(l.taxable), rate: D(l.gst_rate), cgst: D(l.cgst), sgst: D(l.sgst), igst: D(l.igst) });
  const docs: Doc[] = invs.map((i) => ({ id: i.id, number: i.number, date: i.invoiceDate, gstin: i.customerGstin, name: i.customerName, pos: i.placeOfSupply,
    type: i.supplyType, total: D(i.total), lines: allLines.rows.filter((l) => l.invoice_id === i.id).map(mkLine) }));

  const notes = await db.execute<{ id: string; number: string; note_date: string; total: string; supply_type: "INTRA" | "INTER" | "NONE"; invoice_id: string;
    inv_number: string; inv_date: string; inv_total: string; gstin: string | null; name: string; pos: string | null }>(sql`
    SELECT n.id, n.number, n.note_date, n.total, n.supply_type, n.invoice_id, i.number AS inv_number, i.invoice_date AS inv_date, i.total AS inv_total,
      i.customer_gstin AS gstin, i.customer_name AS name, i.place_of_supply AS pos
    FROM gst_notes n JOIN sales_invoices i ON i.id = n.invoice_id
    WHERE n.company_id = ${companyId} AND n.kind = 'CREDIT_NOTE' AND n.note_date BETWEEN ${per.from} AND ${per.to} ORDER BY n.note_date`);
  const noteLines = notes.rows.length ? await db.execute<{ note_id: string; hsn: string | null; unit: string; description: string; quantity: string; taxable: string; gst_rate: string; cgst: string; sgst: string; igst: string }>(sql`
    SELECT nl.note_id, sl.hsn, sl.unit, sl.description, nl.quantity, nl.taxable, nl.gst_rate, nl.cgst, nl.sgst, nl.igst
    FROM gst_note_lines nl JOIN sales_invoice_lines sl ON sl.id = nl.source_line_id
    WHERE nl.note_id IN (SELECT id FROM gst_notes WHERE company_id = ${companyId} AND kind = 'CREDIT_NOTE' AND note_date BETWEEN ${per.from} AND ${per.to})`) : { rows: [] };
  const cns = notes.rows.map((n) => ({ id: n.id, number: n.number, date: n.note_date, total: D(n.total), type: n.supply_type, invNumber: n.inv_number, invDate: n.inv_date,
    invTotal: D(n.inv_total), gstin: n.gstin, name: n.name, pos: n.pos, lines: noteLines.rows.filter((l) => l.note_id === n.id).map(mkLine) }));
  return { docs, cns };
}

const isB2CL = (d: { gstin: string | null; type: string; total: Decimal }) => !d.gstin && d.type === "INTER" && d.total.gt(B2CL_LIMIT);

export async function gstr1(db: DB, companyId: string, per: Period) {
  const company = (await db.query.companies.findFirst({ where: eq(schema.companies.id, companyId) }))!;
  const { docs, cns } = await outward(db, companyId, per);
  const byRate = (lines: Line[]) => {
    const m = new Map<string, { rate: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>();
    for (const l of lines) { const k = l.rate.toString(); const e = m.get(k) ?? { rate: l.rate, taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) };
      m.set(k, { rate: l.rate, taxable: e.taxable.plus(l.taxable), cgst: e.cgst.plus(l.cgst), sgst: e.sgst.plus(l.sgst), igst: e.igst.plus(l.igst) }); }
    return [...m.values()];
  };
  const b2b = docs.filter((d) => d.gstin && d.type !== "NONE");
  const b2cl = docs.filter((d) => d.type !== "NONE" && isB2CL(d));
  const b2csDocs = docs.filter((d) => d.type !== "NONE" && !d.gstin && !isB2CL(d));
  const cdnr = cns.filter((n) => n.gstin && n.type !== "NONE");
  const cdnur = cns.filter((n) => !n.gstin && n.type !== "NONE" && isB2CL({ gstin: null, type: n.type, total: n.invTotal }));
  const b2csNotes = cns.filter((n) => !n.gstin && n.type !== "NONE" && !cdnur.includes(n));

  // B2CS: net of small-B2C returns, grouped by place of supply + rate + supply type.
  const b2csMap = new Map<string, { pos: string; type: "INTRA" | "INTER"; rate: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>();
  const addB2cs = (pos: string | null, type: "INTRA" | "INTER" | "NONE", lines: Line[], sign: 1 | -1) => {
    for (const r of byRate(lines)) {
      const k = `${pos}|${type}|${r.rate}`;
      const e = b2csMap.get(k) ?? { pos: pos ?? company.stateCode ?? "", type: type as "INTRA" | "INTER", rate: r.rate, taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) };
      b2csMap.set(k, { ...e, taxable: e.taxable.plus(r.taxable.mul(sign)), cgst: e.cgst.plus(r.cgst.mul(sign)), sgst: e.sgst.plus(r.sgst.mul(sign)), igst: e.igst.plus(r.igst.mul(sign)) });
    }
  };
  b2csDocs.forEach((d) => addB2cs(d.pos, d.type, d.lines, 1));
  b2csNotes.forEach((n) => addB2cs(n.pos, n.type, n.lines, -1));
  const b2cs = [...b2csMap.values()].filter((x) => !x.taxable.isZero());

  // HSN summary, B2B and B2C separately, net of returns.
  const hsnOf = (docsIn: { lines: Line[] }[], notesIn: { lines: Line[] }[]) => {
    const m = new Map<string, { hsn: string; desc: string; uqc: string; qty: Decimal; rate: Decimal; taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }>();
    const add = (l: Line, s: number) => {
      const k = `${l.hsn ?? ""}|${l.rate}|${l.unit}`;
      const e = m.get(k) ?? { hsn: l.hsn ?? "", desc: l.desc, uqc: UQC[l.unit.toLowerCase()] ?? "OTH", qty: D(0), rate: l.rate, taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) };
      m.set(k, { ...e, qty: e.qty.plus(l.qty.mul(s)), taxable: e.taxable.plus(l.taxable.mul(s)), cgst: e.cgst.plus(l.cgst.mul(s)), sgst: e.sgst.plus(l.sgst.mul(s)), igst: e.igst.plus(l.igst.mul(s)) });
    };
    docsIn.forEach((d) => d.lines.forEach((l) => add(l, 1))); notesIn.forEach((n) => n.lines.forEach((l) => add(l, -1)));
    return [...m.values()];
  };
  const taxed = docs.filter((d) => d.type !== "NONE"), taxedNotes = cns.filter((n) => n.type !== "NONE");
  const hsnB2B = hsnOf(taxed.filter((d) => d.gstin), taxedNotes.filter((n) => n.gstin));
  const hsnB2C = hsnOf(taxed.filter((d) => !d.gstin), taxedNotes.filter((n) => !n.gstin));

  // Documents issued (Table 13).
  const allInv = await db.query.salesInvoices.findMany({ where: and(eq(schema.salesInvoices.companyId, companyId), gte(schema.salesInvoices.invoiceDate, per.from), lte(schema.salesInvoices.invoiceDate, per.to)) });
  const series = (nums: string[]) => { const s = [...nums].sort((a, b) => Number(a.split("/").pop()) - Number(b.split("/").pop())); return s.length ? { from: s[0], to: s[s.length - 1] } : null; };
  const docIssue = [
    { nature: "Invoices for outward supply", ...series(allInv.map((i) => i.number)), total: allInv.length, cancelled: allInv.filter((i) => i.status === "CANCELLED").length },
    { nature: "Credit notes", ...series(cns.map((c) => c.number)), total: cns.length, cancelled: 0 },
  ].filter((d) => d.total > 0);

  const sum = (xs: { taxable: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal }[]) => xs.reduce((a, x) => ({ taxable: a.taxable.plus(x.taxable), cgst: a.cgst.plus(x.cgst), sgst: a.sgst.plus(x.sgst), igst: a.igst.plus(x.igst) }), { taxable: D(0), cgst: D(0), sgst: D(0), igst: D(0) });
  const lineSum = (ds: { lines: Line[] }[]) => sum(ds.flatMap((d) => d.lines));
  const exempt = docs.filter((d) => d.type === "NONE");
  return { company, per, b2b, b2cl, b2cs, cdnr, cdnur, hsnB2B, hsnB2C, docIssue, exempt,
    totals: { invoices: lineSum(taxed), notes: lineSum(taxedNotes), b2b: lineSum(b2b), b2cl: lineSum(b2cl), b2cs: sum(b2cs), cdnr: lineSum(cdnr), cdnur: lineSum(cdnur) } };
}

/** GSTR-1 in the GST portal's offline-tool JSON layout. Validate in the portal's offline tool before filing. */
export function gstr1Json(r: Awaited<ReturnType<typeof gstr1>>) {
  const itms = (lines: Line[]) => {
    const m = new Map<string, { rt: Decimal; txval: Decimal; iamt: Decimal; camt: Decimal; samt: Decimal }>();
    for (const l of lines) { const k = l.rate.toString(); const e = m.get(k) ?? { rt: l.rate, txval: D(0), iamt: D(0), camt: D(0), samt: D(0) };
      m.set(k, { rt: l.rate, txval: e.txval.plus(l.taxable), iamt: e.iamt.plus(l.igst), camt: e.camt.plus(l.cgst), samt: e.samt.plus(l.sgst) }); }
    return [...m.values()].map((x, i) => ({ num: i + 1, itm_det: { txval: n2(x.txval), rt: n2(x.rt), iamt: n2(x.iamt), camt: n2(x.camt), samt: n2(x.samt), csamt: 0 } }));
  };
  const group = <T extends { gstin: string | null }>(xs: T[]) => [...new Set(xs.map((x) => x.gstin!))].map((g) => [g, xs.filter((x) => x.gstin === g)] as const);
  const hsn = (rows: typeof r.hsnB2B) => rows.map((h, i) => ({ num: i + 1, hsn_sc: h.hsn, desc: h.desc.slice(0, 30), uqc: h.uqc, qty: Number(h.qty.toFixed(2)),
    rt: n2(h.rate), txval: n2(h.taxable), iamt: n2(h.igst), camt: n2(h.cgst), samt: n2(h.sgst), csamt: 0 }));
  const out: Record<string, unknown> = { gstin: r.company.gstin, fp: r.per.fp, version: "GST3.2", hash: "hash" };
  if (r.b2b.length) out.b2b = group(r.b2b).map(([ctin, ds]) => ({ ctin, inv: ds.map((d) => ({ inum: d.number, idt: ddmmyyyy(d.date), val: n2(d.total), pos: d.pos, rchrg: "N", inv_typ: "R", itms: itms(d.lines) })) }));
  if (r.b2cl.length) out.b2cl = [...new Set(r.b2cl.map((d) => d.pos))].map((pos) => ({ pos, inv: r.b2cl.filter((d) => d.pos === pos).map((d) => ({ inum: d.number, idt: ddmmyyyy(d.date), val: n2(d.total), itms: itms(d.lines) })) }));
  if (r.b2cs.length) out.b2cs = r.b2cs.map((x) => ({ sply_ty: x.type, pos: x.pos, typ: "OE", rt: n2(x.rate), txval: n2(x.taxable), iamt: n2(x.igst), camt: n2(x.cgst), samt: n2(x.sgst), csamt: 0 }));
  if (r.cdnr.length) out.cdnr = group(r.cdnr).map(([ctin, ns]) => ({ ctin, nt: ns.map((n) => ({ ntty: "C", nt_num: n.number, nt_dt: ddmmyyyy(n.date), val: n2(n.total), pos: n.pos, rchrg: "N", inv_typ: "R", itms: itms(n.lines) })) }));
  if (r.cdnur.length) out.cdnur = r.cdnur.map((n) => ({ typ: "B2CL", ntty: "C", nt_num: n.number, nt_dt: ddmmyyyy(n.date), val: n2(n.total), pos: n.pos, itms: itms(n.lines) }));
  if (r.hsnB2B.length || r.hsnB2C.length) out.hsn = { ...(r.hsnB2B.length ? { hsn_b2b: hsn(r.hsnB2B) } : {}), ...(r.hsnB2C.length ? { hsn_b2c: hsn(r.hsnB2C) } : {}) };
  if (r.docIssue.length) out.doc_issue = { doc_det: r.docIssue.map((d, i) => ({ doc_num: i === 0 ? 1 : 5, docs: [{ num: 1, from: d.from, to: d.to, totnum: d.total, cancel: d.cancelled, net_issue: d.total - d.cancelled }] })) };
  return out;
}

/** Input side for the period: from bills and debit notes (only where GST was claimable). */
export async function inward(db: DB, companyId: string, per: Period) {
  const r = await db.execute<{ igst: string; cgst: string; sgst: string; taxable: string; n: number }>(sql`
    SELECT coalesce(sum(igst),0) AS igst, coalesce(sum(cgst),0) AS cgst, coalesce(sum(sgst),0) AS sgst, coalesce(sum(taxable),0) AS taxable, count(*)::int AS n
    FROM purchase_bills WHERE company_id = ${companyId} AND status = 'ACTIVE' AND itc_claimed AND bill_date BETWEEN ${per.from} AND ${per.to}`);
  const dn = await db.execute<{ igst: string; cgst: string; sgst: string }>(sql`
    SELECT coalesce(sum(n.igst),0) AS igst, coalesce(sum(n.cgst),0) AS cgst, coalesce(sum(n.sgst),0) AS sgst
    FROM gst_notes n JOIN purchase_bills b ON b.id = n.bill_id WHERE n.company_id = ${companyId} AND n.kind = 'DEBIT_NOTE' AND b.itc_claimed AND n.note_date BETWEEN ${per.from} AND ${per.to}`);
  const b = r.rows[0], d = dn.rows[0];
  return { bills: b.n, taxable: D(b.taxable), igst: D(b.igst).minus(d.igst), cgst: D(b.cgst).minus(d.cgst), sgst: D(b.sgst).minus(d.sgst) };
}

export type Heads = { igst: Decimal; cgst: Decimal; sgst: Decimal };
/** Uses input credit against output tax in the legal order. Returns what credit pays, cash to pay, and credit left over. */
export function setOff(liab: Heads, credit: Heads) {
  const L = { ...liab }, C = { ...credit };
  const used = { igst: { igst: D(0), cgst: D(0), sgst: D(0) }, cgst: { cgst: D(0), igst: D(0) }, sgst: { sgst: D(0), igst: D(0) } };
  const take = (from: keyof Heads, to: keyof Heads) => { const a = Decimal.min(C[from], L[to]); if (a.lte(0)) return D(0); C[from] = C[from].minus(a); L[to] = L[to].minus(a); return a; };
  used.igst.igst = take("igst", "igst"); used.igst.cgst = take("igst", "cgst"); used.igst.sgst = take("igst", "sgst");
  used.cgst.cgst = take("cgst", "cgst"); used.cgst.igst = take("cgst", "igst");
  used.sgst.sgst = take("sgst", "sgst"); used.sgst.igst = take("sgst", "igst");
  return { used, cash: L, carryForward: C, cashTotal: L.igst.plus(L.cgst).plus(L.sgst) };
}

export async function gstr3b(db: DB, companyId: string, per: Period) {
  const r1 = await gstr1(db, companyId, per);
  const out = { taxable: r1.totals.invoices.taxable.minus(r1.totals.notes.taxable), igst: r1.totals.invoices.igst.minus(r1.totals.notes.igst),
    cgst: r1.totals.invoices.cgst.minus(r1.totals.notes.cgst), sgst: r1.totals.invoices.sgst.minus(r1.totals.notes.sgst) };
  const inp = await inward(db, companyId, per);
  const unregInter = [...r1.b2cs.filter((x) => x.type === "INTER"), ...r1.b2cl.map((d) => ({ pos: d.pos ?? "", taxable: d.lines.reduce((s, l) => s.plus(l.taxable), D(0)), igst: d.lines.reduce((s, l) => s.plus(l.igst), D(0)) }))];
  const byPos = new Map<string, { taxable: Decimal; igst: Decimal }>();
  for (const x of unregInter) { const e = byPos.get(x.pos) ?? { taxable: D(0), igst: D(0) }; byPos.set(x.pos, { taxable: e.taxable.plus(x.taxable), igst: e.igst.plus(x.igst) }); }
  const exemptTaxable = r1.exempt.reduce((s, d) => s.plus(d.lines.reduce((a, l) => a.plus(l.taxable), D(0))), D(0));
  return { per, out, inp, interUnreg: [...byPos.entries()].map(([pos, v]) => ({ pos, ...v })), exemptTaxable, setoff: setOff(out, inp) };
}

// ───── GSTR-2B matching ─────
export type TwoBDoc = { gstin: string; name: string; number: string; date: string; taxable: string; igst: string; cgst: string; sgst: string; total: string; itcAvailable: boolean };
/** "SFD/0101", "SFD-101", "sfd 101" → "SFD101": drop punctuation and leading zeros of each number group. */
const normNo = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(" ").map((p) => (/^\d+$/.test(p) ? String(Number(p)) : p)).join("");
const numv = (v: unknown) => D(typeof v === "number" || typeof v === "string" ? v : 0);

/** Accepts the portal's GSTR-2B JSON (data.docdata.b2b[].inv[].items[]) and GSTR-2A JSON (b2b[].inv[].itms[].itm_det). */
export function parse2b(json: unknown): TwoBDoc[] {
  const j = json as Record<string, unknown>;
  const data = (j?.data as Record<string, unknown>) ?? j;
  const docdata = (data?.docdata as Record<string, unknown>) ?? data;
  const b2b = (docdata?.b2b ?? j?.b2b) as unknown[];
  if (!Array.isArray(b2b)) throw new UserFacingError("This doesn't look like a GSTR-2B/2A JSON file from the GST portal (no B2B section found).");
  const out: TwoBDoc[] = [];
  for (const s of b2b as Record<string, unknown>[]) {
    for (const inv of (s.inv as Record<string, unknown>[]) ?? []) {
      const items = ((inv.items as Record<string, unknown>[]) ?? (inv.itms as Record<string, unknown>[])?.map((x) => x.itm_det as Record<string, unknown>) ?? []);
      const t = items.reduce<{ tx: Decimal; i: Decimal; c: Decimal; s: Decimal }>((a, it) => ({ tx: a.tx.plus(numv(it.txval)), i: a.i.plus(numv(it.igst ?? it.iamt)), c: a.c.plus(numv(it.cgst ?? it.camt)), s: a.s.plus(numv(it.sgst ?? it.samt)) }), { tx: D(0), i: D(0), c: D(0), s: D(0) });
      const dt = String(inv.dt ?? inv.idt ?? "");
      const m = dt.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      out.push({ gstin: String(s.ctin ?? ""), name: String(s.trdnm ?? ""), number: String(inv.inum ?? ""), date: m ? `${m[3]}-${m[2]}-${m[1]}` : dt,
        taxable: t.tx.toFixed(2), igst: t.i.toFixed(2), cgst: t.c.toFixed(2), sgst: t.s.toFixed(2), total: numv(inv.val).toFixed(2), itcAvailable: String(inv.itcavl ?? "Y") !== "N" });
    }
  }
  return out;
}

export async function import2b(db: DB, companyId: string, userId: string, period: string, fileName: string, raw: string) {
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new UserFacingError("The file isn't valid JSON. Download the JSON (not Excel/PDF) from the GST portal."); }
  const docs = parse2b(json);
  if (!/^\d{4}-\d{2}$/.test(period)) throw new UserFacingError("Choose the month this 2B is for.");
  const [row] = await db.insert(schema.gstr2bImports).values({ companyId, period, fileName, docs, createdBy: userId }).returning();
  await audit(db, { companyId, userId, action: "gstr2b.import", entityType: "gstr2b_import", entityId: row.id, after: { period, docs: docs.length }, source: "import" });
  return row;
}

export async function reconcile2b(db: DB, companyId: string, importId: string) {
  const imp = await db.query.gstr2bImports.findFirst({ where: and(eq(schema.gstr2bImports.id, importId), eq(schema.gstr2bImports.companyId, companyId)) });
  if (!imp) return null;
  const per = parsePeriod(imp.period);
  const bills = await db.execute<{ id: string; bill_number: string; bill_date: string; gstin: string | null; name: string; taxable: string; igst: string; cgst: string; sgst: string; total: string }>(sql`
    SELECT b.id, b.bill_number, b.bill_date, p.gstin, p.name, b.taxable, b.igst, b.cgst, b.sgst, b.total FROM purchase_bills b JOIN parties p ON p.id = b.party_id
    WHERE b.company_id = ${companyId} AND b.status = 'ACTIVE' AND b.itc_claimed AND b.bill_date BETWEEN ${per.from} AND ${per.to}`);
  const docs = imp.docs as TwoBDoc[];
  const used = new Set<string>();
  type Row = { status: "MATCHED" | "AMOUNT_DIFF" | "NOT_IN_BOOKS" | "NOT_IN_2B"; supplier: string; gstin: string; number: string; date: string; books: Decimal | null; portal: Decimal | null; billId?: string; note?: string };
  const rows: Row[] = [];
  for (const d of docs) {
    const b = bills.rows.find((x) => !used.has(x.id) && x.gstin === d.gstin && normNo(x.bill_number) === normNo(d.number));
    const portalTax = D(d.igst).plus(d.cgst).plus(d.sgst);
    if (!b) { rows.push({ status: "NOT_IN_BOOKS", supplier: d.name, gstin: d.gstin, number: d.number, date: d.date, books: null, portal: portalTax,
      note: "Supplier reported this bill, but it isn't recorded in your purchases. Record it if genuine, or ask the supplier." }); continue; }
    used.add(b.id);
    const booksTax = D(b.igst).plus(b.cgst).plus(b.sgst);
    const close = booksTax.minus(portalTax).abs().lte(1) && D(b.taxable).minus(d.taxable).abs().lte(1);
    rows.push({ status: close ? "MATCHED" : "AMOUNT_DIFF", supplier: b.name, gstin: d.gstin, number: b.bill_number, date: b.bill_date, books: booksTax, portal: portalTax, billId: b.id,
      note: close ? (d.itcAvailable ? undefined : "Portal says credit not available for this bill.") : `GST differs by ${formatINR(booksTax.minus(portalTax).abs())}. Check the bill with the supplier.` });
  }
  for (const b of bills.rows.filter((x) => !used.has(x.id))) rows.push({ status: "NOT_IN_2B", supplier: b.name, gstin: b.gstin ?? "", number: b.bill_number, date: b.bill_date,
    books: D(b.igst).plus(b.cgst).plus(b.sgst), portal: null, billId: b.id, note: "Not in 2B yet. Credit may not be claimable until the supplier files. Remind them." });
  const tot = (s: Row["status"]) => rows.filter((r) => r.status === s);
  const riskTax = [...tot("NOT_IN_2B"), ...tot("AMOUNT_DIFF")].reduce((a, r) => a.plus(r.books ?? 0), D(0));
  return { imp, per, rows, counts: { matched: tot("MATCHED").length, diff: tot("AMOUNT_DIFF").length, notInBooks: tot("NOT_IN_BOOKS").length, notIn2b: tot("NOT_IN_2B").length }, riskTax };
}

export async function latest2b(db: DB, companyId: string) {
  return db.query.gstr2bImports.findMany({ where: eq(schema.gstr2bImports.companyId, companyId), orderBy: desc(schema.gstr2bImports.createdAt), limit: 12 });
}

// ───── Items needing review ─────
export type Review = { what: string; why: string; href: string };
export async function gstReview(db: DB, companyId: string, per: Period): Promise<Review[]> {
  const out: Review[] = [];
  const company = (await db.query.companies.findFirst({ where: eq(schema.companies.id, companyId) }))!;
  if (company.gstRegistration === "REGULAR" && !company.gstin) out.push({ what: "Your GSTIN is missing.", why: "Returns and tax invoices need it.", href: "/settings" });
  const prods = await db.query.products.findMany({ where: and(eq(schema.products.companyId, companyId), eq(schema.products.isActive, true)) });
  const noHsn = prods.filter((p) => !p.hsn), noRate = prods.filter((p) => p.gstRate == null), unconf = prods.filter((p) => p.gstRate != null && p.gstRateStatus !== "USER_CONFIRMED");
  if (noHsn.length) out.push({ what: `${noHsn.length} product(s) have no HSN code.`, why: "HSN is needed on tax invoices and in the GSTR-1 HSN summary.", href: "/inventory" });
  if (noRate.length) out.push({ what: `${noRate.length} product(s) have no GST rate.`, why: "They can't be billed until a rate is set.", href: "/inventory" });
  if (unconf.length) out.push({ what: `${unconf.length} product(s) have a GST rate that isn't confirmed.`, why: "A wrong rate means wrong tax on every bill.", href: "/gst/rates" });
  const { hsnConflicts: conflicts, ruleMismatch, rules } = await rateProblems(db, companyId, per.to);
  const mism = ruleMismatch.map((x) => x.p);
  const softMism = prods.filter((p) => { const r = ruleFor(rules, p.hsn, per.to); return r && !trustedRule(r) && p.gstRate != null && !D(r.rate).eq(p.gstRate); });
  if (softMism.length) out.push({ what: `${softMism.length} product(s) differ from an unchecked rate in your table: ${softMism.slice(0, 3).map((p) => p.name).join(", ")}.`, why: "The table rate isn't checked yet, so bills aren't blocked — but one of the two is probably wrong.", href: "/gst/rates" });
  if (conflicts.length) out.push({ what: `${conflicts.length} HSN code(s) have different GST rates on different products: ${conflicts.slice(0, 2).map((c) => `${c.hsn} (${c.rates.map((r) => r.rate + "%").join(" / ")})`).join(", ")}.`, why: "The same HSN code normally has one rate. Check the products against your supplier's bill.", href: "/gst/rates" });
  if (mism.length) out.push({ what: `${mism.length} product(s) have a GST rate different from your rate table: ${mism.slice(0, 3).map((p) => p.name).join(", ")}.`, why: "One of the two is wrong. Until fixed, these bills show a warning (or are refused if 'only bill checked rates' is on).", href: "/gst/rates" });
  const bigCash = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM sales_invoices WHERE company_id = ${companyId} AND status = 'ACTIVE'
    AND supply_type = 'INTER' AND customer_gstin IS NULL AND total > 100000 AND invoice_date BETWEEN ${per.from} AND ${per.to}`);
  if (bigCash.rows[0].n) out.push({ what: `${bigCash.rows[0].n} inter-state bill(s) over ₹1 lakh to unregistered buyers.`, why: "These are reported invoice-by-invoice (B2C Large). Check the buyer really has no GSTIN.", href: `/gst/returns?period=${per.from.slice(0, 7)}` });
  const noState = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM parties WHERE company_id = ${companyId} AND type = 'CUSTOMER' AND state_code IS NULL AND is_active`);
  if (noState.rows[0].n) out.push({ what: `${noState.rows[0].n} customer(s) have no state saved.`, why: "State decides CGST+SGST vs IGST; without it the app assumes your state.", href: "/customers" });
  const unregSup = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM purchase_bills b JOIN parties p ON p.id = b.party_id
    WHERE b.company_id = ${companyId} AND b.status='ACTIVE' AND p.gstin IS NULL AND b.bill_date BETWEEN ${per.from} AND ${per.to}`);
  if (unregSup.rows[0].n) out.push({ what: `${unregSup.rows[0].n} purchase(s) from suppliers with no GSTIN.`, why: "No GST credit can be claimed on these. If the supplier is registered, add their GSTIN.", href: "/suppliers" });
  return out;
}

// ───── Rate table ─────
type Rule = typeof schema.gstRateRules.$inferSelect;
/** Most specific HSN prefix whose dates cover the day. */
export function ruleFor(rules: Rule[], hsn: string | null, day: string) {
  if (!hsn) return null;
  return rules.filter((r) => hsn.startsWith(r.hsnPrefix) && r.effectiveFrom <= day && (!r.effectiveTo || r.effectiveTo >= day))
    .sort((a, b) => b.hsnPrefix.length - a.hsnPrefix.length)[0] ?? null;
}

// ───── Rate checks & strict billing ─────
export type GstStrict = { on: boolean; since: string | null; by: string | null };
export async function gstStrict(q: DB | Tx, companyId: string): Promise<GstStrict> {
  const r = await q.execute<{ value: GstStrict }>(sql`SELECT value FROM settings WHERE company_id = ${companyId} AND key = 'gst_strict'`);
  return r.rows[0]?.value ?? { on: false, since: null, by: null };
}
export async function setGstStrict(db: DB, companyId: string, userId: string, on: boolean) {
  const before = await gstStrict(db, companyId);
  const value: GstStrict = { on, since: on ? new Date().toISOString().slice(0, 10) : null, by: on ? userId : null };
  await db.insert(schema.settings).values({ companyId, key: "gst_strict", value }).onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value } });
  await audit(db, { companyId, userId, action: on ? "gst.strict_on" : "gst.strict_off", entityType: "settings", entityId: companyId, before, after: value });
}

/** A rule counts for checking products only once someone has confirmed it (or it's verified from an official source). */
export const trustedRule = (r: Rule | null) => (r && (r.status === "VERIFIED" || r.status === "USER_CONFIRMED") ? r : null);

/** Everything that could put a wrong GST rate on a bill. */
export async function rateProblems(db: DB | Tx, companyId: string, day: string) {
  const [rules, prods] = await Promise.all([db.query.gstRateRules.findMany({ where: eq(schema.gstRateRules.companyId, companyId) }),
    db.query.products.findMany({ where: and(eq(schema.products.companyId, companyId), eq(schema.products.isActive, true)) })]);
  const unconfirmed = prods.filter((p) => p.gstRate != null && p.gstRateStatus !== "USER_CONFIRMED");
  const noRate = prods.filter((p) => p.gstRate == null);
  const noHsn = prods.filter((p) => !p.hsn);
  const ruleMismatch = prods.map((p) => ({ p, rule: trustedRule(ruleFor(rules, p.hsn, day)) })).filter((x) => x.rule && x.p.gstRate != null && !D(x.rule.rate).eq(x.p.gstRate));
  // Same HSN code on two products but different rates: at least one is wrong.
  const byHsn = new Map<string, typeof prods>();
  for (const p of prods) if (p.hsn && p.gstRate != null) (byHsn.get(p.hsn) ?? byHsn.set(p.hsn, []).get(p.hsn)!).push(p);
  const hsnConflicts = [...byHsn.entries()].filter(([, ps]) => new Set(ps.map((p) => D(p.gstRate!).toString())).size > 1)
    .map(([hsn, ps]) => ({ hsn, rates: [...new Set(ps.map((p) => D(p.gstRate!).toString()))].map((rate) => ({ rate, products: ps.filter((p) => D(p.gstRate!).toString() === rate) })) }));
  return { unconfirmed, noRate, noHsn, ruleMismatch, hsnConflicts, rules };
}

/** Owner confirms several product rates at once (e.g. against one supplier bill). Audited per product with where it was checked. */
export async function confirmProductRates(db: DB, companyId: string, userId: string, ids: string[], checkedAgainst: string) {
  if (!ids.length) throw new UserFacingError("Tick the products you've checked.");
  if (!checkedAgainst.trim()) throw new UserFacingError("Say what you checked them against (e.g. 'SF Sonic bill 1234').");
  const { rules } = await rateProblems(db, companyId, new Date().toISOString().slice(0, 10));
  let n = 0;
  for (const id of ids) {
    const p = await db.query.products.findFirst({ where: and(eq(schema.products.id, id), eq(schema.products.companyId, companyId)) });
    if (!p || p.gstRate == null) continue;
    const rule = trustedRule(ruleFor(rules, p.hsn, new Date().toISOString().slice(0, 10)));
    if (rule && !D(rule.rate).eq(p.gstRate)) throw new UserFacingError(`"${p.name}" is ${D(p.gstRate).toString()}% but your checked rate table says ${D(rule.rate).toString()}% for HSN ${rule.hsnPrefix}. Fix one of them first.`);
    await db.update(schema.products).set({ gstRateStatus: "USER_CONFIRMED", updatedAt: new Date() }).where(eq(schema.products.id, id));
    await audit(db, { companyId, userId, action: "product.gst_confirm", entityType: "product", entityId: id, before: { gstRateStatus: p.gstRateStatus }, after: { gstRate: p.gstRate, hsn: p.hsn, gstRateStatus: "USER_CONFIRMED" }, reason: checkedAgainst.trim() });
    n++;
  }
  return n;
}

/** Starter rules researched on 29 Sep 2026 from non-government sources — deliberately marked SECONDARY_SOURCE. */
export const STARTER_RULES = [
  { hsnPrefix: "8507", description: "Batteries / electric accumulators (lead-acid, lithium-ion)", rate: "18", effectiveFrom: "2025-09-22",
    sourceName: "Tally Solutions guide (56th GST Council changes)", sourceUrl: "https://tallysolutions.com/gst/hsn-code-8507-product-classification-gst-rate-business-filing-guide/",
    notes: "Earlier: many lead-acid batteries 28%. Check against your supplier's GST bill for the same HSN before confirming." },
];

export async function addRule(db: DB, companyId: string, userId: string, r: { hsnPrefix: string; description: string; rate: string; effectiveFrom: string; sourceName?: string; sourceUrl?: string; status: "VERIFIED" | "USER_CONFIRMED" | "SECONDARY_SOURCE" | "UNVERIFIED"; notes?: string }) {
  if (!/^\d{2,8}$/.test(r.hsnPrefix.trim())) throw new UserFacingError("HSN should be 2 to 8 digits.");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(r.rate.trim()) || D(r.rate).gt(40)) throw new UserFacingError("Rate should be a percentage like 18.");
  if (r.status === "VERIFIED" && !r.sourceUrl?.trim()) throw new UserFacingError("To mark a rate verified, give the official notification link.");
  const [row] = await db.insert(schema.gstRateRules).values({ companyId, hsnPrefix: r.hsnPrefix.trim(), description: r.description.trim() || `HSN ${r.hsnPrefix}`, rate: D(r.rate).toFixed(2),
    effectiveFrom: r.effectiveFrom, status: r.status, sourceName: r.sourceName?.trim() || null, sourceUrl: r.sourceUrl?.trim() || null, notes: r.notes?.trim() || null,
    retrievedOn: new Date().toISOString().slice(0, 10), ...(r.status === "VERIFIED" || r.status === "USER_CONFIRMED" ? { confirmedBy: userId, confirmedAt: new Date() } : {}) }).returning();
  await audit(db, { companyId, userId, action: "gst_rule.create", entityType: "gst_rate_rule", entityId: row.id, after: row });
  return row;
}

export async function confirmRule(db: DB, companyId: string, userId: string, id: string, status: "VERIFIED" | "USER_CONFIRMED", sourceUrl?: string) {
  const r = await db.query.gstRateRules.findFirst({ where: and(eq(schema.gstRateRules.id, id), eq(schema.gstRateRules.companyId, companyId)) });
  if (!r) throw new UserFacingError("Rule not found.");
  if (status === "VERIFIED" && !(sourceUrl?.trim() || r.sourceUrl)) throw new UserFacingError("Add the official notification link to mark it verified.");
  const [after] = await db.update(schema.gstRateRules).set({ status, confirmedBy: userId, confirmedAt: new Date(), ...(sourceUrl?.trim() ? { sourceUrl: sourceUrl.trim() } : {}) })
    .where(eq(schema.gstRateRules.id, id)).returning();
  await audit(db, { companyId, userId, action: "gst_rule.confirm", entityType: "gst_rate_rule", entityId: id, before: r, after });
  return after;
}

/** Sets matching products' rate from a confirmed rule (owner-triggered, never automatic). */
export async function applyRuleToProducts(db: DB, companyId: string, userId: string, ruleId: string) {
  const r = await db.query.gstRateRules.findFirst({ where: and(eq(schema.gstRateRules.id, ruleId), eq(schema.gstRateRules.companyId, companyId)) });
  if (!r) throw new UserFacingError("Rule not found.");
  if (r.status !== "VERIFIED" && r.status !== "USER_CONFIRMED") throw new UserFacingError("Confirm this rate first; unconfirmed rates are never applied to products.");
  const prods = await db.query.products.findMany({ where: eq(schema.products.companyId, companyId) });
  const hits = prods.filter((p) => p.hsn?.startsWith(r.hsnPrefix));
  for (const p of hits) {
    await db.update(schema.products).set({ gstRate: r.rate, gstRateStatus: "USER_CONFIRMED", updatedAt: new Date() }).where(eq(schema.products.id, p.id));
    await audit(db, { companyId, userId, action: "product.gst_from_rule", entityType: "product", entityId: p.id, before: { gstRate: p.gstRate }, after: { gstRate: r.rate, rule: r.id } });
  }
  return hits.length;
}

// ───── Record GST paid for a period ─────
/**
 * Posts the set-off + cash payment for a period: clears output GST using input credit in the legal order,
 * and records the cash paid from bank. Uses ledger balances up to the period end, so earlier unpaid
 * amounts and carried-forward credit are included.
 */
export async function gstLedgerPosition(db: DB, companyId: string, asOf: string) {
  const r = await db.execute<{ k: string; v: string }>(sql`
    SELECT a.system_key AS k, coalesce(sum(l.credit - l.debit),0) AS v FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
      -- Everything up to the period end, PLUS every GST settlement already recorded (even if dated later),
      -- so the same period can never be paid twice.
      AND l.entry_id IN (SELECT id FROM journal_entries WHERE company_id = ${companyId} AND (entry_date <= ${asOf} OR source_type = 'gst_payment'))
    WHERE a.company_id = ${companyId} AND a.system_key IN ('OUTPUT_CGST','OUTPUT_SGST','OUTPUT_UTGST','OUTPUT_IGST','INPUT_CGST','INPUT_SGST','INPUT_UTGST','INPUT_IGST')
    GROUP BY a.system_key`);
  const v = (k: string) => D(r.rows.find((x) => x.k === k)?.v ?? 0);
  const liab = { igst: v("OUTPUT_IGST"), cgst: v("OUTPUT_CGST"), sgst: v("OUTPUT_SGST").plus(v("OUTPUT_UTGST")) };
  const credit = { igst: v("INPUT_IGST").neg(), cgst: v("INPUT_CGST").neg(), sgst: v("INPUT_SGST").neg().plus(v("INPUT_UTGST").neg()) };
  return { liab, credit, setoff: setOff(liab, credit), utgst: v("OUTPUT_UTGST").gt(0) || v("INPUT_UTGST").lt(0) };
}

export async function recordGstPayment(db: DB, p: { companyId: string; userId: string; asOf: string; paidOn: string; bankId: string; reference?: string }) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    const pos = await gstLedgerPosition(t, p.companyId, p.asOf);
    const { used, cash } = pos.setoff;
    const sg = pos.utgst ? "UTGST" : "SGST";
    const L: LineInput[] = [];
    const add = (k: string, side: "debit" | "credit", v: Decimal) => { if (v.gt(0)) L.push({ systemKey: k, [side]: toDb(v) }); };
    // Liabilities cleared (debit output) = credit used + cash paid, per head.
    add("OUTPUT_IGST", "debit", used.igst.igst.plus(used.cgst.igst).plus(used.sgst.igst).plus(cash.igst));
    add("OUTPUT_CGST", "debit", used.igst.cgst.plus(used.cgst.cgst).plus(cash.cgst));
    add(`OUTPUT_${sg}`, "debit", used.igst.sgst.plus(used.sgst.sgst).plus(cash.sgst));
    add("INPUT_IGST", "credit", used.igst.igst.plus(used.igst.cgst).plus(used.igst.sgst));
    add("INPUT_CGST", "credit", used.cgst.cgst.plus(used.cgst.igst));
    add(`INPUT_${sg}`, "credit", used.sgst.sgst.plus(used.sgst.igst));
    if (pos.setoff.cashTotal.gt(0)) {
      const bank = await tx.query.accounts.findFirst({ where: and(eq(schema.accounts.id, p.bankId), eq(schema.accounts.companyId, p.companyId)) });
      if (!bank) throw new UserFacingError("Choose the bank account the GST was paid from.");
      L.push({ accountId: bank.id, credit: toDb(pos.setoff.cashTotal) });
    }
    if (L.length < 2) throw new UserFacingError("Nothing to settle: no GST payable and no credit to use up to this date.");
    const e = await postEntryTx(tx, { companyId: p.companyId, userId: p.userId, voucherType: "JOURNAL", date: p.paidOn, sourceType: "gst_payment",
      narration: `GST set-off and payment up to ${p.asOf}${p.reference?.trim() ? ` (challan ${p.reference.trim()})` : ""}`, lines: L });
    await audit(tx, { companyId: p.companyId, userId: p.userId, action: "gst.payment", entityType: "journal_entry", entityId: e.id, after: { cash: pos.setoff.cashTotal.toFixed(2), asOf: p.asOf } });
    return { entry: e, cash: pos.setoff.cashTotal };
  });
}

/** Output/input GST in the ledger vs the documents. Must match. */
export async function gstReconciliation(db: DB, companyId: string) {
  const docs = await db.execute<{ out: string; inp: string }>(sql`
    SELECT
      (SELECT coalesce(sum(cgst+sgst+igst),0) FROM sales_invoices WHERE company_id = ${companyId} AND status='ACTIVE')
      - (SELECT coalesce(sum(cgst+sgst+igst),0) FROM gst_notes WHERE company_id = ${companyId} AND kind='CREDIT_NOTE') AS out,
      (SELECT coalesce(sum(cgst+sgst+igst),0) FROM purchase_bills WHERE company_id = ${companyId} AND status='ACTIVE' AND itc_claimed)
      - (SELECT coalesce(sum(n.cgst+n.sgst+n.igst),0) FROM gst_notes n JOIN purchase_bills b ON b.id = n.bill_id WHERE n.company_id = ${companyId} AND n.kind='DEBIT_NOTE' AND b.itc_claimed) AS inp`);
  const led = await db.execute<{ out: string; inp: string }>(sql`
    SELECT coalesce(sum(CASE WHEN a.system_key LIKE 'OUTPUT_%' AND a.system_key <> 'OUTPUT_CESS' THEN l.credit - l.debit END),0) AS out,
           coalesce(sum(CASE WHEN a.system_key LIKE 'INPUT_%' AND a.system_key <> 'INPUT_CESS' THEN l.debit - l.credit END),0) AS inp
    FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
    WHERE l.company_id = ${companyId} AND e.source_type <> 'gst_payment'`);
  const d = docs.rows[0], l = led.rows[0];
  return { docsOut: D(d.out), ledgerOut: D(l.out), docsIn: D(d.inp), ledgerIn: D(l.inp), ok: D(d.out).eq(l.out) && D(d.inp).eq(l.inp) };
}
