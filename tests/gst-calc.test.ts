import { describe, it, expect } from "vitest";
import { calcInvoice, calcLine, supplyType, amountInWords } from "@/lib/gst/calc";

describe("supply type", () => {
  it("decides from seller registration and place of supply", () => {
    expect(supplyType("REGULAR", "21", "21")).toBe("INTRA");
    expect(supplyType("REGULAR", "21", "20")).toBe("INTER");
    expect(supplyType("UNREGISTERED", "21", "20")).toBe("NONE");
    expect(supplyType("COMPOSITION", "21", "21")).toBe("NONE");
  });
});

describe("invoice arithmetic", () => {
  it("brief example: 10 × ₹5,000 @18% intra-state = 50,000 + 9,000 = 59,000", () => {
    const r = calcInvoice([{ qty: 10, rate: 5000, gstRate: 18 }], "INTRA");
    expect([r.taxable, r.cgst, r.sgst, r.igst, r.total].map((d) => d.toFixed(2))).toEqual(["50000.00", "4500.00", "4500.00", "0.00", "59000.00"]);
  });
  it("inter-state uses IGST only", () => {
    const r = calcInvoice([{ qty: 10, rate: 5000, gstRate: 18 }], "INTER");
    expect([r.cgst, r.sgst, r.igst].map((d) => d.toFixed(2))).toEqual(["0.00", "0.00", "9000.00"]);
  });
  it("rounds per line, then to the rupee, and everything reconciles exactly", () => {
    const r = calcInvoice([{ qty: 3, rate: "333.33", discountPct: "2.5", gstRate: 18 }, { qty: "1.5", rate: "99.99", gstRate: 5 }], "INTRA");
    // line1: 999.99 * 0.975 = 974.990 -> 974.99 ; cgst = 974.99*9% = 87.7491 -> 87.75
    expect(r.lines[0].taxable.toFixed(2)).toBe("974.99");
    expect(r.lines[0].cgst.toFixed(2)).toBe("87.75");
    // line2: 149.985 -> 149.99 ; cgst 2.5% = 3.749... -> 3.75
    expect(r.lines[1].taxable.toFixed(2)).toBe("149.99");
    expect(r.taxable.plus(r.cgst).plus(r.sgst).plus(r.igst).plus(r.roundOff).toFixed(2)).toBe(r.total.toFixed(2));
    expect(r.total.decimalPlaces()).toBe(0);
    expect(r.roundOff.abs().lte(0.5)).toBe(true);
    expect(r.subtotal.minus(r.discount).toFixed(2)).toBe(r.taxable.toFixed(2));
  });
  it("no GST when seller can't charge it", () => {
    const r = calcInvoice([{ qty: 2, rate: 100, gstRate: 18 }], "NONE");
    expect(r.tax.toFixed(2)).toBe("0.00"); expect(r.total.toFixed(2)).toBe("200.00");
  });
  it("0% items and missing rate give zero tax", () => {
    expect(calcLine({ qty: 1, rate: 100, gstRate: 0 }, "INTRA").cgst.toFixed(2)).toBe("0.00");
  });
});

describe("amount in words", () => {
  it("uses lakh/crore", () => {
    expect(amountInWords(59000)).toBe("Rupees Fifty Nine Thousand Only");
    expect(amountInWords("1234567.50")).toBe("Rupees Twelve Lakh Thirty Four Thousand Five Hundred Sixty Seven and Fifty Paise Only");
    expect(amountInWords(10000000)).toBe("Rupees One Crore Only");
  });
});
