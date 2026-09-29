import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { db, pool, schema, type DB } from "@/db";
import * as S from "@/db/schema";
import { registerOwner, addBankAccount, updateBusinessInfo, updateGstInfo, addUser } from "@/lib/services/company";
import { createParty, recordCustomerPayment } from "@/lib/services/parties";
import { createProduct } from "@/lib/services/inventory";
import { createSale, cancelSale } from "@/lib/services/sales";
import { createBill } from "@/lib/services/purchases";
import { createCreditNote, returnableLines } from "@/lib/services/notes";
import { setOpeningBalances } from "@/lib/services/vouchers";
import { trialBalance, ledgerHealth } from "@/lib/accounting/reports";
import { exportCompany, packBackup, unpackBackup, restoreCompany } from "@/lib/services/backup";
import { gstinCheckChar } from "@/lib/gst/gstin";

const g = (b: string) => b + gstinCheckChar(b);
const rpool = new Pool({ connectionString: "postgresql://bizos:bizos@localhost:5432/bizos_restore_test" });
const rdb = drizzle(rpool, { schema: S }) as unknown as DB;
afterAll(async () => { await pool.end(); await rpool.end(); });
let cid = "", uid = "";

beforeAll(async () => {
  await rpool.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await migrate(drizzle(rpool), { migrationsFolder: "./drizzle" });
  const r = await registerOwner(db, { name: "BK", email: `bk_${Date.now()}@t.in`, password: "secret123", businessName: "Backup Co" });
  cid = r.company.id; uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "Backup Co", stateCode: "21" });
  await updateGstInfo(db, cid, uid, { registration: "REGULAR", gstin: g("21AAAAA1111A1Z") });
  await addUser(db, cid, uid, { name: "Staff", email: `bks_${Date.now()}@t.in`, password: "secret123", role: "SALESPERSON" });
  const bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2026-04-01", balances: { [bank]: "123456.78" } });
  const p = (await createProduct(db, cid, uid, { name: "Battery", hsn: "8507", gstRate: "18", gstConfirmed: true })).id;
  const sup = (await createParty(db, cid, uid, "SUPPLIER", { name: "Sup", gstin: g("21BBBBB2222B1Z") })).id;
  const cus = (await createParty(db, cid, uid, "CUSTOMER", { name: "Cus", openingBalance: "999.99", openingDate: "2026-04-01" })).id;
  await createBill(db, { companyId: cid, userId: uid, partyId: sup, billNumber: "B1", date: "2026-05-01", lines: [{ productId: p, qty: "10", rate: "4000.33" }] });
  const s1 = await createSale(db, { companyId: cid, userId: uid, partyId: cus, date: "2026-05-02", lines: [{ productId: p, qty: "3", rate: "5000.55" }] });
  const s2 = await createSale(db, { companyId: cid, userId: uid, partyId: cus, date: "2026-05-03", lines: [{ productId: p, qty: "1", rate: "5100" }] });
  await cancelSale(db, { companyId: cid, userId: uid, invoiceId: s2.invoice.id, reason: "wrong" });
  const [l] = await returnableLines(db, "CREDIT_NOTE", s1.invoice.id);
  await createCreditNote(db, { companyId: cid, userId: uid, invoiceId: s1.invoice.id, date: "2026-05-05", reason: "faulty", lines: [{ sourceLineId: l.id, qty: "1" }] });
  await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: cus, cashBankId: bank, amount: "5000", date: "2026-05-06" });
});

describe("backup and restore", () => {
  it("round-trips a business exactly and every check passes on the restored copy", async () => {
    const b = unpackBackup(packBackup(await exportCompany(db, cid)));
    expect(b.counts.journal_entries).toBeGreaterThan(5); expect(b.counts.users).toBe(2);
    expect(Object.keys(b.tables)).not.toContain("login_attempts");
    await restoreCompany(rdb, b);
    const [a, c] = await Promise.all([trialBalance(db, cid, "2026-12-31"), trialBalance(rdb, cid, "2026-12-31")]);
    expect(c.totalDebit.toString()).toBe(a.totalDebit.toString());
    expect(c.rows.map((r) => [r.code, r.debitBalance.toString(), r.creditBalance.toString()])).toEqual(a.rows.map((r) => [r.code, r.debitBalance.toString(), r.creditBalance.toString()]));
    const health = await ledgerHealth(rdb, cid);
    expect(health.filter((h) => !h.ok)).toEqual([]);
    const rev = await rdb.execute(sql`SELECT count(*)::int n FROM journal_entries WHERE company_id = ${cid} AND status = 'REVERSED'`);
    const orig = await db.execute(sql`SELECT count(*)::int n FROM journal_entries WHERE company_id = ${cid} AND status = 'REVERSED'`);
    expect(rev.rows[0]).toEqual(orig.rows[0]);
    const inv = await rdb.query.salesInvoices.findMany({ where: eq(S.salesInvoices.companyId, cid) });
    expect(inv.map((i) => i.status).sort()).toEqual(["ACTIVE", "CANCELLED"]);
    // the restored ledger is still protected
    await expect(rdb.execute(sql`DELETE FROM journal_entries WHERE company_id = ${cid}`)).rejects.toThrow();
  });
  it("refuses to restore twice or into a different app version; damaged file refused", async () => {
    const b = await exportCompany(db, cid);
    await expect(restoreCompany(rdb, b)).rejects.toThrow(/already/);
    await expect(restoreCompany(rdb, { ...b, companyId: "00000000-0000-0000-0000-000000000000", migrations: 1 })).rejects.toThrow(/version/);
    const bad = packBackup(b); bad[bad.length - 5] ^= 0xff;
    expect(() => unpackBackup(bad)).toThrow();
    expect(() => unpackBackup(Buffer.from('{"format":"x"}'))).toThrow(/Sanskriti/);
  });
  it("backup of one business contains nothing from another", async () => {
    const other = await registerOwner(db, { name: "O", email: `o_${Date.now()}@t.in`, password: "secret123", businessName: "Other" });
    const b = await exportCompany(db, cid);
    expect(JSON.stringify(b)).not.toContain(other.company.id);
    expect(JSON.stringify(b)).not.toContain(other.user.email);
  });
});
