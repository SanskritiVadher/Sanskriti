/**
 * Guided corrections for an owner without an accountant. Each one asks a plain question and posts the
 * right double entry through the engine. No debit/credit knowledge needed.
 */
import { and, eq } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { D, toDb } from "@/lib/money";
import { postEntry, LedgerError } from "@/lib/accounting/engine";
import { trialBalance, naturalBalance } from "@/lib/accounting/reports";

type Base = { companyId: string; userId: string; date: string; amount: string; note?: string };

function amt(v: string) {
  const s = (v ?? "").replace(/[,₹\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s) || D(s).lte(0)) throw new LedgerError("Please enter an amount greater than zero (up to 2 decimals).", "amount");
  return toDb(s);
}
async function account(db: DB, companyId: string, id: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, id), eq(schema.accounts.companyId, companyId)) });
  if (!a) throw new LedgerError("Account not found.");
  const g = await db.query.accountGroups.findFirst({ where: eq(schema.accountGroups.id, a.groupId) });
  return { ...a, groupCode: g!.code };
}
const CASH_BANK = ["1110", "1120"];
const note = (n: string | undefined, f: string) => n?.trim() || f;

/** "I put it in the wrong category": move an amount between two income or two expense categories. */
export async function moveCategory(db: DB, p: Base & { fromId: string; toId: string }) {
  const a = amt(p.amount);
  const [from, to] = [await account(db, p.companyId, p.fromId), await account(db, p.companyId, p.toId)];
  if (from.id === to.id) throw new LedgerError("Choose two different categories.", "toId");
  if (!["EXPENSE", "INCOME"].includes(from.nature) || from.nature !== to.nature)
    throw new LedgerError("Both must be expense categories, or both income categories.", "toId");
  if (from.systemKey === "COGS" || to.systemKey === "COGS") throw new LedgerError("Cost of goods sold is calculated automatically and can't be moved here.");
  const tb = await trialBalance(db, p.companyId, p.date);
  const row = tb.rows.find((r) => r.accountId === from.id)!;
  if (naturalBalance(row.nature, row.totalDebit, row.totalCredit).lt(a))
    throw new LedgerError(`"${from.ownerLabel}" only has ${naturalBalance(row.nature, row.totalDebit, row.totalCredit).toFixed(2)} recorded up to this date.`, "amount");
  const debitSide = from.nature === "EXPENSE";
  return postEntry(db, { companyId: p.companyId, userId: p.userId, voucherType: "JOURNAL", date: p.date, sourceType: "correction",
    narration: note(p.note, `Corrected category: ${from.ownerLabel} → ${to.ownerLabel}`),
    lines: debitSide ? [{ accountId: to.id, debit: a }, { accountId: from.id, credit: a }] : [{ accountId: from.id, debit: a }, { accountId: to.id, credit: a }] });
}

/** "I owe a bill but haven't paid it yet": expense now, payable until paid. */
export async function unpaidBill(db: DB, p: Base & { expenseId: string }) {
  const a = amt(p.amount);
  const e = await account(db, p.companyId, p.expenseId);
  if (e.nature !== "EXPENSE" || e.systemKey === "COGS") throw new LedgerError("Choose an expense, like rent or electricity.", "expenseId");
  return postEntry(db, { companyId: p.companyId, userId: p.userId, voucherType: "JOURNAL", date: p.date, sourceType: "correction",
    narration: note(p.note, `Bill not yet paid: ${e.ownerLabel}`),
    lines: [{ accountId: e.id, debit: a }, { systemKey: "EXPENSES_PAYABLE", credit: a }] });
}

/** "I took money out for personal use" / "I put my own money in". */
export async function ownerMoney(db: DB, p: Base & { cashBankId: string; direction: "OUT" | "IN" }) {
  const a = amt(p.amount);
  const cb = await account(db, p.companyId, p.cashBankId);
  if (!CASH_BANK.includes(cb.groupCode)) throw new LedgerError("Choose a cash or bank account.", "cashBankId");
  return postEntry(db, { companyId: p.companyId, userId: p.userId, voucherType: p.direction === "OUT" ? "PAYMENT" : "RECEIPT", date: p.date, sourceType: "correction",
    narration: note(p.note, p.direction === "OUT" ? "Owner took money for personal use" : "Owner put own money into the business"),
    lines: p.direction === "OUT" ? [{ systemKey: "DRAWINGS", debit: a }, { accountId: cb.id, credit: a }]
      : [{ accountId: cb.id, debit: a }, { systemKey: "CAPITAL", credit: a }] });
}

/** "My van / equipment has lost value": depreciation. Amount comes from the owner or CA; we don't invent rates. */
export async function depreciation(db: DB, p: Base & { assetId: string }) {
  const a = amt(p.amount);
  const asset = await account(db, p.companyId, p.assetId);
  if (asset.groupCode !== "1200") throw new LedgerError("Choose a long-term asset like vehicles or furniture.", "assetId");
  const tb = await trialBalance(db, p.companyId, p.date);
  const row = tb.rows.find((r) => r.accountId === asset.id)!;
  const bal = naturalBalance(row.nature, row.totalDebit, row.totalCredit);
  if (bal.lt(a)) throw new LedgerError(`"${asset.ownerLabel}" is only recorded at ${bal.toFixed(2)}. Depreciation can't be more than that.`, "amount");
  return postEntry(db, { companyId: p.companyId, userId: p.userId, voucherType: "JOURNAL", date: p.date, sourceType: "correction",
    narration: note(p.note, `Depreciation: ${asset.ownerLabel}`),
    lines: [{ systemKey: "DEPRECIATION", debit: a }, { accountId: asset.id, credit: a }] });
}

export async function correctionOptions(db: DB, companyId: string) {
  const groups = await db.query.accountGroups.findMany({ where: eq(schema.accountGroups.companyId, companyId) });
  const byCode = new Map(groups.map((g) => [g.id, g.code]));
  const accs = await db.query.accounts.findMany({ where: and(eq(schema.accounts.companyId, companyId), eq(schema.accounts.isActive, true)), orderBy: schema.accounts.code });
  const o = (list: typeof accs) => list.map((a) => ({ id: a.id, label: a.ownerLabel, code: a.code, group: "" }));
  return {
    expenses: o(accs.filter((a) => a.nature === "EXPENSE" && !["COGS", "STOCK_ADJUSTMENT", "DEPRECIATION", "ROUND_OFF"].includes(a.systemKey ?? ""))),
    income: o(accs.filter((a) => a.nature === "INCOME" && !["SALES", "SALES_RETURNS"].includes(a.systemKey ?? ""))),
    cashBank: o(accs.filter((a) => CASH_BANK.includes(byCode.get(a.groupId)!))),
    fixed: o(accs.filter((a) => byCode.get(a.groupId) === "1200")),
  };
}
