/**
 * Invoice arithmetic — pure, shared by the billing screen (live preview) and the server (authoritative).
 * Rounding rules (applied consistently):
 *   1. line taxable  = round₂(qty × rate × (1 − discount%))
 *   2. intra-state   : CGST = round₂(taxable × rate/2 %), SGST (or UTGST) = same
 *      inter-state   : IGST = round₂(taxable × rate %)
 *   3. totals        = sum of rounded line values (never recomputed from totals)
 *   4. round-off     = to the nearest rupee (half up); shown as its own line
 * Tax treatment comes from the seller's registration and the place of supply — not from the user.
 */
import Decimal from "decimal.js";

const R = Decimal.ROUND_HALF_UP;
const D = (v: Decimal.Value | null | undefined) => new Decimal(v === "" || v == null ? 0 : v);
const r2 = (d: Decimal) => d.toDecimalPlaces(2, R);

export type Registration = "REGULAR" | "COMPOSITION" | "UNREGISTERED";
export type LineIn = { qty: Decimal.Value; rate: Decimal.Value; discountPct?: Decimal.Value; gstRate: Decimal.Value | null };

/** INTRA: same state → CGST+SGST. INTER: different state → IGST. NONE: seller can't charge GST. */
export function supplyType(seller: Registration, sellerState: string | null, placeOfSupply: string | null): "INTRA" | "INTER" | "NONE" {
  if (seller !== "REGULAR") return "NONE";
  if (!sellerState || !placeOfSupply) return "INTRA";
  return sellerState === placeOfSupply ? "INTRA" : "INTER";
}

export function calcLine(l: LineIn, type: "INTRA" | "INTER" | "NONE") {
  const qty = D(l.qty), rate = D(l.rate), disc = D(l.discountPct ?? 0);
  const gross = r2(qty.mul(rate));
  const taxable = r2(qty.mul(rate).mul(new Decimal(100).minus(disc)).div(100));
  const discount = gross.minus(taxable);
  const gr = type === "NONE" ? D(0) : D(l.gstRate ?? 0);
  const cgst = type === "INTRA" ? r2(taxable.mul(gr).div(200)) : D(0);
  const sgst = cgst;
  const igst = type === "INTER" ? r2(taxable.mul(gr).div(100)) : D(0);
  return { gross, discount, taxable, gstRate: gr, cgst, sgst, igst, total: taxable.plus(cgst).plus(sgst).plus(igst) };
}

export function calcInvoice(lines: LineIn[], type: "INTRA" | "INTER" | "NONE", opts: { roundToRupee?: boolean } = {}) {
  const calc = lines.map((l) => calcLine(l, type));
  const sum = (k: "gross" | "discount" | "taxable" | "cgst" | "sgst" | "igst" | "total") => calc.reduce((s, c) => s.plus(c[k]), D(0));
  const beforeRound = sum("total");
  const total = opts.roundToRupee === false ? beforeRound : beforeRound.toDecimalPlaces(0, R);
  return {
    lines: calc, subtotal: sum("gross"), discount: sum("discount"), taxable: sum("taxable"),
    cgst: sum("cgst"), sgst: sum("sgst"), igst: sum("igst"), tax: sum("cgst").plus(sum("sgst")).plus(sum("igst")),
    roundOff: total.minus(beforeRound), total,
  };
}

/** Rupees in words (Indian system) for the invoice. */
export function amountInWords(v: Decimal.Value) {
  const n = D(v).toDecimalPlaces(2, R);
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x: number) => (x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? " " + ones[x % 10] : ""}`);
  const three = (x: number) => (x >= 100 ? `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? " " + two(x % 100) : ""}` : two(x));
  const words = (x: number): string => {
    if (x === 0) return "Zero";
    const parts: string[] = [];
    const crore = Math.floor(x / 1e7); x %= 1e7;
    const lakh = Math.floor(x / 1e5); x %= 1e5;
    const thousand = Math.floor(x / 1e3); x %= 1e3;
    if (crore) parts.push(`${words(crore)} Crore`);
    if (lakh) parts.push(`${two(lakh)} Lakh`);
    if (thousand) parts.push(`${two(thousand)} Thousand`);
    if (x) parts.push(three(x));
    return parts.join(" ");
  };
  const rupees = n.trunc().toNumber(), paise = n.minus(n.trunc()).mul(100).toNumber();
  return `Rupees ${words(rupees)}${paise ? ` and ${two(paise)} Paise` : ""} Only`;
}
