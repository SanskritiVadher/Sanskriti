/**
 * "Things that look unusual" — rule-based checks over the last 90 days. Each finding says what was
 * found, why it is flagged (with the figures), and where to look. A finding is a question, not an accusation:
 * the owner can mark it "checked, it's fine" (audited) and it won't show again.
 */
import { sql } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { D, formatINR } from "@/lib/money";
import { todayIST, fmtDate } from "@/lib/dates";
import { audit } from "@/lib/services/audit";

export type Finding = { key: string; kind: string; tone: "bad" | "warn" | "info"; what: string; why: string; action: string; href: string; date: string };
export const KIND_LABEL: Record<string, string> = {
  DUP_BILL: "Possible duplicate bill", DUP_SALE: "Possible duplicate invoice", BELOW_COST: "Sold below cost", CHEAP: "Price much lower than usual",
  BIG: "Unusually large amount", BACKDATED: "Entered much later than its date", CASH_IN: "Large cash receipt", CASH_OUT: "Large cash payment",
  OVER_LIMIT: "Over credit limit", REVERSALS: "Many cancellations", EXPENSE_JUMP: "Expense jumped",
};

const shift = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

export async function dismissed(db: DB, companyId: string) {
  const r = await db.execute<{ value: string[] }>(sql`SELECT value FROM settings WHERE company_id = ${companyId} AND key = 'anomaly_ok'`);
  return new Set(r.rows[0]?.value ?? []);
}
export async function markChecked(db: DB, companyId: string, userId: string, key: string, note: string) {
  if (!/^[A-Z_]+:[\w:.-]+$/.test(key)) throw new Error("Bad key");
  const s = [...(await dismissed(db, companyId)), key].slice(-2000);
  await db.insert(schema.settings).values({ companyId, key: "anomaly_ok", value: s })
    .onConflictDoUpdate({ target: [schema.settings.companyId, schema.settings.key], set: { value: s } });
  await audit(db, { companyId, userId, action: "check.ok", entityType: "finding", entityId: null, after: { key }, reason: note || undefined });
}

export async function findings(db: DB, companyId: string, asOf = todayIST(), opts: { includeChecked?: boolean } = {}) {
  const from = shift(asOf, -89);
  const out: Finding[] = [];
  const q = <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => db.execute<T>(s).then((r) => r.rows);

  // 1. Same supplier, same total, within 7 days — often the same bill entered twice.
  for (const r of await q<{ a: string; b: string; an: string; bn: string; ad: string; bd: string; total: string; name: string }>(sql`
    SELECT a.id a, b.id b, a.bill_number an, b.bill_number bn, a.bill_date ad, b.bill_date bd, a.total, p.name FROM purchase_bills a
    JOIN purchase_bills b ON b.company_id = a.company_id AND b.party_id = a.party_id AND b.total = a.total AND b.id > a.id AND abs(b.bill_date - a.bill_date) <= 7 AND b.status = 'ACTIVE'
    JOIN parties p ON p.id = a.party_id
    WHERE a.company_id = ${companyId} AND a.status = 'ACTIVE' AND greatest(a.bill_date, b.bill_date) BETWEEN ${from} AND ${asOf}`))
    out.push({ key: `DUP_BILL:${r.a}:${r.b}`, kind: "DUP_BILL", tone: "bad", date: r.bd, href: `/buy/${r.b}`,
      what: `${r.name}: two bills of ${formatINR(r.total)} — ${r.an} (${fmtDate(r.ad)}) and ${r.bn} (${fmtDate(r.bd)}).`,
      why: "Same supplier, same amount, within a week. If it's the same bill entered twice, you'd pay twice and claim GST twice.", action: "Compare both with the supplier's paper bills. If one is a copy, cancel it." });

  // 2. Same customer, same total, same day.
  for (const r of await q<{ a: string; b: string; an: string; bn: string; d: string; total: string; name: string }>(sql`
    SELECT a.id a, b.id b, a.number an, b.number bn, a.invoice_date d, a.total, a.customer_name name FROM sales_invoices a
    JOIN sales_invoices b ON b.company_id = a.company_id AND b.party_id = a.party_id AND b.total = a.total AND b.id > a.id AND b.invoice_date = a.invoice_date AND b.status = 'ACTIVE'
    WHERE a.company_id = ${companyId} AND a.status = 'ACTIVE' AND a.invoice_date BETWEEN ${from} AND ${asOf}`))
    out.push({ key: `DUP_SALE:${r.a}:${r.b}`, kind: "DUP_SALE", tone: "warn", date: r.d, href: `/sell/${r.b}`,
      what: `${r.name}: invoices ${r.an} and ${r.bn}, both ${formatINR(r.total)} on ${fmtDate(r.d)}.`,
      why: "Same customer, same amount, same day. The customer would be charged twice.", action: "If it's a repeat order, mark it fine. If not, cancel one." });

  // 3. Line sold for less than what the goods cost.
  for (const r of await q<{ id: string; inv: string; number: string; d: string; product: string; taxable: string; cost: string; name: string }>(sql`
    SELECT l.id, i.id inv, i.number, i.invoice_date d, l.description product, l.taxable, l.cost_value cost, i.customer_name name
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
    WHERE i.company_id = ${companyId} AND i.status = 'ACTIVE' AND i.invoice_date BETWEEN ${from} AND ${asOf} AND l.taxable < l.cost_value`))
    out.push({ key: `BELOW_COST:${r.id}`, kind: "BELOW_COST", tone: "bad", date: r.d, href: `/sell/${r.inv}`,
      what: `${r.product} sold to ${r.name} on ${r.number} for ${formatINR(r.taxable)} (before GST); it cost you ${formatINR(r.cost)}.`,
      why: `A loss of ${formatINR(D(r.cost).minus(r.taxable))} on this line.`, action: "If it was clearance or a scheme, mark it fine. Otherwise check the rate typed." });

  // 4. Rate far below this product's usual (median) rate over the window.
  for (const r of await q<{ id: string; inv: string; number: string; d: string; product: string; rate: string; usual: string; name: string }>(sql`
    WITH m AS (SELECT l.product_id, percentile_cont(0.5) WITHIN GROUP (ORDER BY l.rate * (1 - l.discount_pct/100)) usual, count(*) n
      FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id
      WHERE i.company_id = ${companyId} AND i.status = 'ACTIVE' AND i.invoice_date BETWEEN ${from} AND ${asOf} GROUP BY 1)
    SELECT l.id, i.id inv, i.number, i.invoice_date d, l.description product, round(l.rate * (1 - l.discount_pct/100), 2) rate, round(m.usual::numeric, 2) usual, i.customer_name name
    FROM sales_invoice_lines l JOIN sales_invoices i ON i.id = l.invoice_id JOIN m ON m.product_id = l.product_id
    WHERE i.company_id = ${companyId} AND i.status = 'ACTIVE' AND i.invoice_date BETWEEN ${from} AND ${asOf} AND m.n >= 4
      AND l.rate * (1 - l.discount_pct/100) < m.usual * 0.8 AND l.taxable >= l.cost_value`))
    out.push({ key: `CHEAP:${r.id}`, kind: "CHEAP", tone: "warn", date: r.d, href: `/sell/${r.inv}`,
      what: `${r.product} sold to ${r.name} at ${formatINR(r.rate)} on ${r.number}; you usually get ${formatINR(r.usual)}.`,
      why: `${D(r.usual).minus(r.rate).div(r.usual).mul(100).toFixed(0)}% below your usual selling rate (middle value of recent sales).`, action: "Check whether this discount was intended." });

  // 5. Money in / out far bigger than usual for that kind of entry.
  for (const r of await q<{ id: string; vt: string; no: string; d: string; amt: string; usual: string; nar: string | null }>(sql`
    WITH base AS (SELECT voucher_type, percentile_cont(0.5) WITHIN GROUP (ORDER BY total_amount) usual, count(*) n FROM journal_entries
      WHERE company_id = ${companyId} AND status = 'POSTED' AND voucher_type IN ('RECEIPT','PAYMENT') AND entry_date BETWEEN ${shift(asOf, -179)} AND ${asOf} GROUP BY 1)
    SELECT e.id, e.voucher_type vt, e.voucher_number no, e.entry_date d, e.total_amount amt, round(b.usual::numeric, 2) usual, e.narration nar
    FROM journal_entries e JOIN base b ON b.voucher_type = e.voucher_type
    WHERE e.company_id = ${companyId} AND e.status = 'POSTED' AND e.entry_date BETWEEN ${from} AND ${asOf} AND b.n >= 8 AND e.total_amount >= 50000 AND e.total_amount > b.usual * 5`))
    out.push({ key: `BIG:${r.id}`, kind: "BIG", tone: "info", date: r.d, href: `/reports/entry/${r.id}`,
      what: `${r.vt === "RECEIPT" ? "Money in" : "Money out"} of ${formatINR(r.amt)} on ${fmtDate(r.d)} (${r.no})${r.nar ? ` — "${r.nar}"` : ""}.`,
      why: `More than 5 times your usual ${r.vt === "RECEIPT" ? "receipt" : "payment"} of ${formatINR(r.usual)}.`, action: "Check the amount has no extra zero." });

  // 6. Entered long after its date (back-dated).
  for (const r of await q<{ id: string; no: string; d: string; created: string; amt: string; who: string }>(sql`
    SELECT e.id, e.voucher_number no, e.entry_date d, (e.created_at AT TIME ZONE 'Asia/Kolkata')::date::text created, e.total_amount amt, u.name who
    FROM journal_entries e JOIN users u ON u.id = e.created_by
    WHERE e.company_id = ${companyId} AND e.voucher_type NOT IN ('OPENING','REVERSAL') AND e.source_type NOT IN ('opening','import')
      AND (e.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from} AND ${asOf} AND (e.created_at AT TIME ZONE 'Asia/Kolkata')::date - e.entry_date > 30`))
    out.push({ key: `BACKDATED:${r.id}`, kind: "BACKDATED", tone: "info", date: r.created, href: `/reports/entry/${r.id}`,
      what: `${r.no} (${formatINR(r.amt)}) dated ${fmtDate(r.d)} was entered by ${r.who} on ${fmtDate(r.created)}.`,
      why: "Entries made more than 30 days after their date can change figures you've already seen or filed (GST returns).", action: "Confirm it was genuinely missed, and whether a filed return needs correcting." });

  // 7 & 8. Cash-rule breaches per person per day.
  for (const r of await q<{ party: string; name: string; d: string; amt: string; dir: string }>(sql`
    SELECT l.party_id party, p.name, e.entry_date d, sum(cl.debit + cl.credit) amt, e.voucher_type::text dir
    FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id AND l.party_id IS NOT NULL
    JOIN journal_lines cl ON cl.entry_id = e.id JOIN accounts a ON a.id = cl.account_id AND a.system_key = 'CASH'
    JOIN parties p ON p.id = l.party_id
    WHERE e.company_id = ${companyId} AND e.status = 'POSTED' AND e.voucher_type IN ('RECEIPT','PAYMENT') AND e.entry_date BETWEEN ${from} AND ${asOf}
    GROUP BY l.party_id, p.name, e.entry_date, e.voucher_type HAVING (e.voucher_type = 'RECEIPT' AND sum(cl.debit) >= 200000) OR (e.voucher_type = 'PAYMENT' AND sum(cl.credit) > 10000)`)) {
    const inn = r.dir === "RECEIPT";
    out.push({ key: `${inn ? "CASH_IN" : "CASH_OUT"}:${r.party}:${r.d}`, kind: inn ? "CASH_IN" : "CASH_OUT", tone: inn ? "bad" : "warn", date: r.d, href: `/${inn ? "customers" : "suppliers"}/${r.party}`,
      what: `${formatINR(r.amt)} in cash ${inn ? "from" : "to"} ${r.name} on ${fmtDate(r.d)}.`,
      why: inn ? "Receiving ₹2 lakh or more in cash from one person in a day can attract a penalty equal to the amount." : "Cash payments over ₹10,000 to one person in a day may not be allowed as a business expense.",
      action: inn ? "Ask this customer to pay large amounts by bank or UPI." : "Pay this supplier by bank or UPI." });
  }

  // 9. Customers above their credit limit right now.
  for (const r of await q<{ id: string; name: string; bal: string; lim: string }>(sql`
    SELECT p.id, p.name, sum(l.debit - l.credit) bal, p.credit_limit lim FROM parties p
    JOIN journal_lines l ON l.party_id = p.id JOIN journal_entries e ON e.id = l.entry_id AND e.entry_date <= ${asOf}
    JOIN accounts a ON a.id = l.account_id AND a.system_key = 'DEBTORS_CONTROL'
    WHERE p.company_id = ${companyId} AND p.type = 'CUSTOMER' AND p.credit_limit > 0 GROUP BY p.id HAVING sum(l.debit - l.credit) > p.credit_limit`))
    out.push({ key: `OVER_LIMIT:${r.id}:${D(r.bal).toFixed(0)}`, kind: "OVER_LIMIT", tone: "warn", date: asOf, href: `/customers/${r.id}`,
      what: `${r.name} owes ${formatINR(r.bal)} — above the limit of ${formatINR(r.lim)}.`, why: `${formatINR(D(r.bal).minus(r.lim))} over the limit you set.`, action: "Collect before giving more goods on credit." });

  // 10. Many cancellations by one person in 30 days.
  for (const r of await q<{ uid: string; who: string; n: number }>(sql`
    SELECT e.created_by uid, u.name who, count(*)::int n FROM journal_entries e JOIN users u ON u.id = e.created_by
    WHERE e.company_id = ${companyId} AND e.voucher_type = 'REVERSAL' AND e.entry_date BETWEEN ${shift(asOf, -29)} AND ${asOf} GROUP BY 1,2 HAVING count(*) >= 6`))
    out.push({ key: `REVERSALS:${r.uid}:${asOf.slice(0, 7)}`, kind: "REVERSALS", tone: "warn", date: asOf, href: "/reports/audit",
      what: `${r.who} cancelled or reversed ${r.n} entries in the last 30 days.`, why: "Frequent cancellations can mean mistakes in entry — or sales being removed after cash was taken.", action: "Look at the audit trail for the reasons given." });

  // 11. An expense this month well above its usual monthly level.
  const mStart = asOf.slice(0, 8) + "01", prev3 = shift(mStart, -1).slice(0, 8) + "01";
  const p3start = new Date(Date.UTC(+prev3.slice(0, 4), +prev3.slice(5, 7) - 3, 1)).toISOString().slice(0, 10);
  for (const r of await q<{ id: string; label: string; now: string; avg: string }>(sql`
    SELECT a.id, a.owner_label label, sum(l.debit - l.credit) FILTER (WHERE e.entry_date >= ${mStart}) now,
      coalesce(sum(l.debit - l.credit) FILTER (WHERE e.entry_date < ${mStart}), 0) / 3 avg
    FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN accounts a ON a.id = l.account_id JOIN account_groups g ON g.id = a.group_id
    WHERE l.company_id = ${companyId} AND g.code IN ('5200','5300') AND a.system_key IS DISTINCT FROM 'ROUND_OFF' AND e.entry_date BETWEEN ${p3start} AND ${asOf}
    GROUP BY a.id HAVING count(*) FILTER (WHERE e.entry_date < ${mStart}) >= 2`)) {
    const now = D(r.now ?? 0), avg = D(r.avg);
    if (avg.gt(0) && now.gt(avg.mul(2)) && now.minus(avg).gte(10000))
      out.push({ key: `EXPENSE_JUMP:${r.id}:${mStart.slice(0, 7)}`, kind: "EXPENSE_JUMP", tone: "info", date: asOf, href: `/reports/ledger/${r.id}`,
        what: `${r.label}: ${formatINR(now)} so far this month.`, why: `Your usual is about ${formatINR(avg.toDecimalPlaces(0))} a month (average of the last 3 months).`, action: "Check the entries in this account." });
  }

  const ok = await dismissed(db, companyId);
  const rank = { bad: 0, warn: 1, info: 2 };
  const all = out.sort((a, b) => rank[a.tone] - rank[b.tone] || b.date.localeCompare(a.date));
  return { open: all.filter((f) => !ok.has(f.key)), checked: opts.includeChecked ? all.filter((f) => ok.has(f.key)) : [], from, asOf };
}
