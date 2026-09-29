import Decimal from "decimal.js";

// All money maths goes through decimal.js. Rounding: half-up to 2 places (paise).
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type Money = Decimal;
export const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
export const toPaise = (v: Decimal.Value) => D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
/** String form for numeric(18,2) columns. */
export const toDb = (v: Decimal.Value) => toPaise(v).toFixed(2);

/** Indian grouping: 1234567.5 -> "₹12,34,567.50" */
export function formatINR(v: Decimal.Value, opts: { paise?: boolean } = {}) {
  const d = toPaise(v);
  const neg = d.isNegative();
  const [int, frac] = d.abs().toFixed(2).split(".");
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${neg ? "-" : ""}₹${grouped}${opts.paise === false ? "" : "." + frac}`;
}

/** Owner-friendly short form: ₹18.4 lakh, ₹1.2 crore, ₹84,000 */
export function formatINRShort(v: Decimal.Value) {
  const d = toPaise(v);
  const a = d.abs();
  const sign = d.isNegative() ? "-" : "";
  if (a.gte(1e7)) return `${sign}₹${a.div(1e7).toDecimalPlaces(2).toString()} crore`;
  if (a.gte(1e5)) return `${sign}₹${a.div(1e5).toDecimalPlaces(1).toString()} lakh`;
  return formatINR(d, { paise: false });
}
