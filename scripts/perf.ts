/** Seeds a year of busy trading into a throwaway business and times the heavy pages' data work.
 *  Usage: DATABASE_URL=<a NON-production db> npx tsx scripts/perf.ts */
import { db, pool } from "../src/db";
import { registerOwner, addBankAccount, updateBusinessInfo } from "../src/lib/services/company";
import { createParty, recordCustomerPayment } from "../src/lib/services/parties";
import { createProduct } from "../src/lib/services/inventory";
import { createSale } from "../src/lib/services/sales";
import { createBill } from "../src/lib/services/purchases";
import { setOpeningBalances } from "../src/lib/services/vouchers";
import { attentionItems } from "../src/lib/services/attention";
import { dailyBrief, weeklyReview } from "../src/lib/services/brief";
import { businessHealth } from "../src/lib/analytics/health";
import { computeRatios } from "../src/lib/analytics/ratios";
import { profitability } from "../src/lib/analytics/profitability";
import { stockInsights } from "../src/lib/analytics/stock";
import { findings } from "../src/lib/analytics/anomalies";
import { profitAndLoss, balanceSheet, cashFlow } from "../src/lib/accounting/statements";
import { trialBalance, ledgerHealth } from "../src/lib/accounting/reports";
import { gstr1, gstr3b, parsePeriod } from "../src/lib/services/gst";
import { ageing } from "../src/lib/services/receivables";
import { exportCompany, packBackup } from "../src/lib/services/backup";

if (/neon\.tech/.test(process.env.DATABASE_URL ?? "")) { console.error("Refusing to run against Neon (production)."); process.exit(1); }
const INVOICES = Number(process.env.INVOICES ?? 5000);
const add = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

async function main() {
  const t0 = Date.now();
  const r = await registerOwner(db, { name: "Perf", email: `perf_${Date.now()}@t.in`, password: "secret123", businessName: "Perf Traders" });
  const cid = r.company.id, uid = r.user.id;
  await updateBusinessInfo(db, cid, uid, { name: "Perf Traders", stateCode: "21" });
  const bank = (await addBankAccount(db, cid, uid, { bankName: "SBI" })).accountId;
  await setOpeningBalances(db, { companyId: cid, userId: uid, date: "2025-04-01", balances: { [bank]: "5000000" } });
  const products = [] as string[];
  for (let i = 0; i < 60; i++) products.push((await createProduct(db, cid, uid, { name: `Item ${i}`, hsn: "8507", gstRate: "18", gstConfirmed: true })).id);
  const custs = [] as string[], sups = [] as string[];
  for (let i = 0; i < 80; i++) custs.push((await createParty(db, cid, uid, "CUSTOMER", { name: `Customer ${i}`, creditDays: "30" })).id);
  for (let i = 0; i < 10; i++) sups.push((await createParty(db, cid, uid, "SUPPLIER", { name: `Supplier ${i}` })).id);
  const perDay = Math.ceil(INVOICES / 300);
  let d = "2025-04-02", n = 0;
  while (n < INVOICES) {
    if (n % (perDay * 7) === 0) for (const s of sups.slice(0, 3))
      await createBill(db, { companyId: cid, userId: uid, partyId: s, billNumber: `B${n}-${s.slice(0, 4)}`, date: d, lines: products.slice(0, 20).map((p) => ({ productId: p, qty: String(perDay * 3), rate: "1000" })) });
    for (let k = 0; k < perDay && n < INVOICES; k++, n++) {
      const c = custs[n % custs.length];
      await createSale(db, { companyId: cid, userId: uid, partyId: c, date: d, creditOverrideReason: "perf",
        lines: [0, 1].map((j) => ({ productId: products[(n + j * 7) % 20], qty: "1", rate: String(1200 + (n % 50)) })) });
      if (n % 2 === 0) await recordCustomerPayment(db, { companyId: cid, userId: uid, partyId: c, cashBankId: bank, amount: "2500", date: d });
    }
    d = add(d, 1);
    if (n % 1000 < perDay) console.log(`  ${n} invoices… ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`Seeded ${n} invoices in ${Math.round((Date.now() - t0) / 1000)}s. Timing (ms):`);
  const to = d, from = "2025-04-01", p = parsePeriod(to.slice(0, 7));
  const time = async (label: string, f: () => Promise<unknown>) => { const s = Date.now(); await f(); console.log(`  ${label.padEnd(28)} ${Date.now() - s}`); };
  await time("home: attention items", () => attentionItems(db, cid));
  await time("today: daily brief", () => dailyBrief(db, cid, to));
  await time("weekly review", () => weeklyReview(db, cid, to));
  await time("business health (year)", () => businessHealth(db, cid, from, to));
  await time("ratios (year)", () => computeRatios(db, cid, from, to));
  await time("profitability by product", () => profitability(db, cid, from, to, "product"));
  await time("stock insights", () => stockInsights(db, cid, to));
  await time("unusual checks", () => findings(db, cid, to));
  await time("customer ageing", () => ageing(db, cid, "CUSTOMER", to));
  await time("P&L (year)", () => profitAndLoss(db, cid, from, to));
  await time("balance sheet", () => balanceSheet(db, cid, to));
  await time("cash flow (year)", () => cashFlow(db, cid, from, to));
  await time("trial balance", () => trialBalance(db, cid, to));
  await time("system health checks", () => ledgerHealth(db, cid));
  await time("GSTR-1 (month)", () => gstr1(db, cid, p));
  await time("GSTR-3B (month)", () => gstr3b(db, cid, p));
  await time("backup download", async () => { const b = packBackup(await exportCompany(db, cid)); console.log(`    backup size ${(b.length / 1e6).toFixed(1)} MB`); });
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
