import { stateByCode } from "./states";

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/** Computes the 15th (check) character of a GSTIN from its first 14 characters. */
export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = CHARS.indexOf(first14[i]);
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

export type GstinCheck =
  | { ok: true; gstin: string; stateCode: string; stateName: string; pan: string }
  | { ok: false; message: string };

/**
 * Validates GSTIN structure and checksum offline. This proves the number is well-formed,
 * NOT that it is currently active on the GST portal — the UI says so.
 */
export function validateGstin(raw: string): GstinCheck {
  const g = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (g.length !== 15) return { ok: false, message: "A GSTIN has exactly 15 characters." };
  if (!FORMAT.test(g)) return { ok: false, message: "This doesn't look like a GSTIN. Please check the characters." };
  const state = stateByCode(g.slice(0, 2));
  if (!state) return { ok: false, message: `The first two digits (${g.slice(0, 2)}) are not a valid state code.` };
  if (gstinCheckChar(g.slice(0, 14)) !== g[14])
    return { ok: false, message: "The last character doesn't match. There may be a typing mistake." };
  return { ok: true, gstin: g, stateCode: state.code, stateName: state.name, pan: g.slice(2, 12) };
}
