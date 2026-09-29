import { describe, it, expect } from "vitest";
import { validateGstin, gstinCheckChar } from "@/lib/gst/gstin";
import { GST_STATES } from "@/lib/gst/states";
import { DEFAULT_ACCOUNTS, DEFAULT_GROUPS } from "@/lib/accounting/chart-of-accounts";
import { formatINR, formatINRShort, toDb, D } from "@/lib/money";
import { can, ROLES } from "@/lib/permissions";
import { financialYearFor } from "@/lib/services/company";

describe("GSTIN validation", () => {
  it("accepts a known valid GSTIN and extracts state + PAN", () => {
    const r = validateGstin("27aapfu0939f1zv");
    expect(r).toEqual({ ok: true, gstin: "27AAPFU0939F1ZV", stateCode: "27", stateName: "Maharashtra", pan: "AAPFU0939F" });
  });
  it("rejects a wrong check digit", () => {
    const r = validateGstin("27AAPFU0939F1ZA");
    expect(r.ok).toBe(false);
  });
  it("rejects bad length, bad format and unknown state", () => {
    expect(validateGstin("27AAPFU0939F1Z").ok).toBe(false);
    expect(validateGstin("2XAAPFU0939F1ZV").ok).toBe(false);
    const body = "99AAPFU0939F1Z";
    expect(validateGstin(body + gstinCheckChar(body)).ok).toBe(false);
  });
  it("round-trips a generated checksum for a Rajasthan GSTIN", () => {
    const body = "08ABCDE1234F1Z";
    const r = validateGstin(body + gstinCheckChar(body));
    expect(r.ok && r.stateName).toBe("Rajasthan");
  });
});

describe("state list", () => {
  it("has unique codes and marks UTGST territories", () => {
    expect(new Set(GST_STATES.map((s) => s.code)).size).toBe(GST_STATES.length);
    const utgst = GST_STATES.filter((s) => s.utgst).map((s) => s.code).sort();
    expect(utgst).toEqual(["04", "26", "31", "35", "38", "97"]);
    expect(GST_STATES.find((s) => s.code === "07")?.utgst).toBe(false); // Delhi has a legislature → SGST
  });
});

describe("default chart of accounts", () => {
  const groupCodes = new Set(DEFAULT_GROUPS.map((g) => g.code));
  it("has unique codes and keys", () => {
    expect(groupCodes.size).toBe(DEFAULT_GROUPS.length);
    expect(new Set(DEFAULT_ACCOUNTS.map((a) => a.code)).size).toBe(DEFAULT_ACCOUNTS.length);
    expect(new Set(DEFAULT_ACCOUNTS.map((a) => a.key)).size).toBe(DEFAULT_ACCOUNTS.length);
  });
  it("every parent/group reference exists and parents are defined first", () => {
    const seen = new Set<string>();
    for (const g of DEFAULT_GROUPS) { if (g.parent) expect(seen.has(g.parent)).toBe(true); seen.add(g.code); }
    for (const a of DEFAULT_ACCOUNTS) expect(groupCodes.has(a.group)).toBe(true);
  });
  it("child groups share their parent's nature", () => {
    const by = new Map(DEFAULT_GROUPS.map((g) => [g.code, g]));
    for (const g of DEFAULT_GROUPS) if (g.parent) expect(by.get(g.parent)!.nature).toBe(g.nature);
  });
  it("contains every ledger the posting engine will need", () => {
    const keys = new Set(DEFAULT_ACCOUNTS.map((a) => a.key));
    for (const k of ["CASH", "DEBTORS_CONTROL", "CREDITORS_CONTROL", "INVENTORY", "SALES", "SALES_RETURNS", "COGS", "ROUND_OFF",
      "INPUT_CGST", "INPUT_SGST", "INPUT_IGST", "INPUT_UTGST", "OUTPUT_CGST", "OUTPUT_SGST", "OUTPUT_IGST", "OUTPUT_UTGST",
      "OPENING_BALANCE_EQUITY", "CAPITAL", "DISCOUNT_ALLOWED", "DISCOUNT_RECEIVED"]) expect(keys.has(k)).toBe(true);
  });
});

describe("money", () => {
  it("never uses float arithmetic", () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(D("0.1").plus("0.2").toFixed(2)).toBe("0.30");
  });
  it("rounds half-up to paise", () => {
    expect(toDb("10.005")).toBe("10.01");
    expect(toDb("10.004")).toBe("10.00");
  });
  it("formats Indian style", () => {
    expect(formatINR("1234567.5")).toBe("₹12,34,567.50");
    expect(formatINR("999")).toBe("₹999.00");
    expect(formatINR("-100000")).toBe("-₹1,00,000.00");
    expect(formatINR(D(0).neg())).toBe("₹0.00");
    expect(formatINRShort("1840000")).toBe("₹18.4 lakh");
    expect(formatINRShort("84000")).toBe("₹84,000");
    expect(formatINRShort("12500000")).toBe("₹1.25 crore");
  });
});

describe("financial year", () => {
  it("April–March", () => {
    expect(financialYearFor(new Date(2026, 8, 29))).toEqual({ name: "FY 2026-27", start: "2026-04-01", end: "2027-03-31" });
    expect(financialYearFor(new Date(2027, 1, 10))).toEqual({ name: "FY 2026-27", start: "2026-04-01", end: "2027-03-31" });
  });
});

describe("permissions", () => {
  it("only owner and admin manage users; viewer can only view", () => {
    expect(ROLES.filter((r) => can(r, "users.manage"))).toEqual(["OWNER", "ADMIN"]);
    expect(ROLES.filter((r) => can(r, "ledger.post_manual"))).toEqual(["OWNER", "ACCOUNTANT"]);
    expect(can("VIEWER", "sales.create")).toBe(false);
    expect(can("SALESPERSON", "reports.financial")).toBe(false);
  });
});
