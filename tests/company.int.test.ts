import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool, schema } from "@/db";
import {
  registerOwner, authenticate, updateBusinessInfo, updateGstInfo, addBankAccount, addBrand, addUser, UserFacingError,
} from "@/lib/services/company";
import { DEFAULT_ACCOUNTS, DEFAULT_GROUPS } from "@/lib/accounting/chart-of-accounts";
import { gstinCheckChar } from "@/lib/gst/gstin";

afterAll(async () => { await pool.end(); });

const rj = (body: string) => body + gstinCheckChar(body);

describe("company setup (database)", async () => {
  const { user, company } = await registerOwner(db, { name: "Ramesh Sharma", email: "Ramesh@Example.com", password: "secret123", businessName: "Sharma Battery House" });

  it("creates owner membership, godown, FY and full chart of accounts atomically", async () => {
    const m = await db.query.memberships.findFirst({ where: eq(schema.memberships.userId, user.id) });
    expect(m?.role).toBe("OWNER");
    const groups = await db.query.accountGroups.findMany({ where: eq(schema.accountGroups.companyId, company.id) });
    const accs = await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, company.id) });
    expect(groups).toHaveLength(DEFAULT_GROUPS.length);
    expect(accs).toHaveLength(DEFAULT_ACCOUNTS.length);
    const gById = new Map(groups.map((g) => [g.id, g]));
    for (const a of accs) expect(gById.get(a.groupId)!.nature).toBe(a.nature);
    expect(await db.query.warehouses.findMany({ where: eq(schema.warehouses.companyId, company.id) })).toHaveLength(1);
    expect(await db.query.financialPeriods.findMany({ where: eq(schema.financialPeriods.companyId, company.id) })).toHaveLength(1);
    const logs = await db.query.auditLogs.findMany({ where: eq(schema.auditLogs.companyId, company.id) });
    expect(logs.map((l) => l.action)).toContain("company.create");
  });

  it("stores emails lowercased and blocks duplicates", async () => {
    await expect(registerOwner(db, { name: "X", email: "ramesh@example.com", password: "secret123", businessName: "Y" }))
      .rejects.toBeInstanceOf(UserFacingError);
  });

  it("rejects a short password without creating anything", async () => {
    const before = (await db.select().from(schema.companies)).length;
    await expect(registerOwner(db, { name: "Z", email: "z@example.com", password: "short", businessName: "Z" })).rejects.toThrow();
    expect((await db.select().from(schema.companies)).length).toBe(before);
  });

  it("authenticates with correct password only, same message for unknown email", async () => {
    const ok = await authenticate(db, "RAMESH@example.com", "secret123");
    expect(ok.companyId).toBe(company.id);
    await expect(authenticate(db, "ramesh@example.com", "wrong")).rejects.toThrow("Email or password is incorrect.");
    await expect(authenticate(db, "nobody@example.com", "secret123")).rejects.toThrow("Email or password is incorrect.");
  });

  it("validates business info and audits before/after", async () => {
    await expect(updateBusinessInfo(db, company.id, user.id, { name: "S", pincode: "12" })).rejects.toThrow("PIN code");
    await updateBusinessInfo(db, company.id, user.id, { name: "Sharma Battery House", stateCode: "08", pincode: "302001", city: "Jaipur", addressLine1: "MI Road" });
    const log = await db.query.auditLogs.findFirst({ where: and(eq(schema.auditLogs.companyId, company.id), eq(schema.auditLogs.action, "company.update")) });
    expect((log?.after as { city: string }).city).toBe("Jaipur");
  });

  it("rejects a GSTIN from a different state than the address", async () => {
    await expect(updateGstInfo(db, company.id, user.id, { registration: "REGULAR", gstin: rj("27ABCDE1234F1Z") }))
      .rejects.toThrow(/Maharashtra.*Rajasthan/);
  });

  it("accepts a matching GSTIN and derives PAN", async () => {
    const c = await updateGstInfo(db, company.id, user.id, { registration: "REGULAR", gstin: rj("08ABCDE1234F1Z").toLowerCase() });
    expect(c.gstin).toBe(rj("08ABCDE1234F1Z"));
    expect(c.pan).toBe("ABCDE1234F");
  });

  it("unregistered clears GSTIN", async () => {
    const c = await updateGstInfo(db, company.id, user.id, { registration: "UNREGISTERED" });
    expect(c.gstin).toBeNull();
  });

  it("adds bank accounts as ledgers under Bank Accounts and stores only last 4 digits", async () => {
    const b1 = await addBankAccount(db, company.id, user.id, { bankName: "SBI", accountNumber: "1234 5678 9012", ifsc: "sbin0001234" });
    const b2 = await addBankAccount(db, company.id, user.id, { bankName: "HDFC Bank" });
    expect(b1.accountNumberLast4).toBe("9012");
    expect(b1.ifsc).toBe("SBIN0001234");
    const a1 = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, b1.accountId) });
    const a2 = await db.query.accounts.findFirst({ where: eq(schema.accounts.id, b2.accountId) });
    expect([a1?.code, a2?.code]).toEqual(["1121", "1122"]);
    expect(a1?.nature).toBe("ASSET");
    await expect(addBankAccount(db, company.id, user.id, { bankName: "X", ifsc: "BAD" })).rejects.toThrow("IFSC");
  });

  it("adds brands and blocks case-insensitive duplicates", async () => {
    await addBrand(db, company.id, user.id, "SF Sonic");
    await addBrand(db, company.id, user.id, "Usha");
    await expect(addBrand(db, company.id, user.id, "sf sonic")).rejects.toThrow("already added");
  });

  it("adds team members with a role", async () => {
    const u = await addUser(db, company.id, user.id, { name: "Priya", email: "priya@example.com", password: "welcome123", role: "ACCOUNTANT" });
    const m = await db.query.memberships.findFirst({ where: eq(schema.memberships.userId, u.id) });
    expect(m?.role).toBe("ACCOUNTANT");
  });
});
