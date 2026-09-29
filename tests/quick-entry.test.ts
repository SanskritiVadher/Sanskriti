import { describe, it, expect } from "vitest";
import { parseQuickEntry, type QParty, type QAccount } from "@/lib/assist/quick-entry";

const parties: QParty[] = [
  { id: "c1", name: "Ramesh Traders", type: "CUSTOMER" }, { id: "c2", name: "Sahu Battery House", type: "CUSTOMER" },
  { id: "c3", name: "Mohan Electricals", type: "CUSTOMER" }, { id: "c4", name: "Mohanty Stores", type: "CUSTOMER" },
  { id: "s1", name: "SF Sonic Distributors", type: "SUPPLIER" }, { id: "s2", name: "Usha International", type: "SUPPLIER" },
];
const accounts: QAccount[] = ["RENT", "SALARIES", "OFFICE_EXPENSES", "FREIGHT_OUTWARD", "DRAWINGS", "CAPITAL", "BANK_LOAN", "ELECTRICITY"]
  .map((k) => ({ id: k.toLowerCase(), systemKey: k, label: k, groupCode: "5300" }));
const P = (t: string) => parseQuickEntry(t, { parties, accounts, today: "2026-09-29" });

describe("quick entry parser", () => {
  it("customer payment in cash", () => {
    const p = P("Ramesh paid 5000 cash");
    expect(p).toMatchObject({ kind: "CUSTOMER_PAYMENT", partyId: "c1", amount: "5000", mode: "CASH", date: "2026-09-29" });
    expect(p.unclear).toEqual([]);
  });
  it("Hinglish + lakh + upi + yesterday", () => {
    expect(P("sahu se 1.5 lakh mila upi kal")).toMatchObject({ kind: "CUSTOMER_PAYMENT", partyId: "c2", amount: "150000", mode: "BANK", date: "2026-09-28" });
  });
  it("supplier payment with commas and ₹", () => {
    expect(P("paid ₹25,000 to SF Sonic by NEFT")).toMatchObject({ kind: "SUPPLIER_PAYMENT", partyId: "s1", amount: "25000", mode: "BANK" });
  });
  it("expense keywords", () => {
    expect(P("chai 200 cash")).toMatchObject({ kind: "EXPENSE", accountId: "office_expenses", amount: "200", mode: "CASH" });
    expect(P("shop rent 12k bank")).toMatchObject({ kind: "EXPENSE", accountId: "rent", amount: "12000" });
    expect(P("bijli bill 3400")).toMatchObject({ kind: "EXPENSE", accountId: "electricity", mode: null });
  });
  it("date dd/mm is not read as amount; future date means last year", () => {
    expect(P("Usha paid 8000 cash on 12/09")).toMatchObject({ amount: "8000", date: "2026-09-12", partyId: "s2" });
    expect(P("rent 5000 cash 15/12").date).toBe("2025-12-15");
  });
  it("contra and drawings and capital", () => {
    expect(P("deposited 20000 cash to bank").kind).toBe("DEPOSIT");
    expect(P("withdrew 5000 from atm").kind).toBe("WITHDRAW");
    expect(P("took 3000 for home cash")).toMatchObject({ kind: "DRAWINGS", accountId: "drawings" });
    expect(P("invested 1 lakh capital bank")).toMatchObject({ kind: "MONEY_IN", accountId: "capital", amount: "100000" });
  });
  it("exact word beats partial; a real tie asks instead of guessing", () => {
    expect(P("mohan 4000 cash mila").partyId).toBe("c3");
    const p = parseQuickEntry("gupta paid 4000 cash", { parties: [{ id: "a", name: "Gupta Traders", type: "CUSTOMER" }, { id: "b", name: "Gupta Stores", type: "CUSTOMER" }], accounts, today: "2026-09-29" });
    expect(p.partyId).toBeNull(); expect(p.partyCandidates.map((x) => x.id)).toEqual(["a", "b"]); expect(p.unclear[0]).toMatch(/Which one/);
  });
  it("says what it can't tell", () => {
    const p = P("something happened");
    expect(p.kind).toBeNull(); expect(p.amount).toBeNull(); expect(p.unclear.length).toBeGreaterThan(1);
  });
});
