import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { db } from "@/db";
import { getContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { profitAndLoss, balanceSheet, cashFlow } from "@/lib/accounting/statements";
import { trialBalance } from "@/lib/accounting/reports";
import { audit } from "@/lib/services/audit";

export const dynamic = "force-dynamic";
/** One workbook (for the owner, a banker, or a tax auditor): P&L, balance sheet, cash flow, trial balance. Every figure from the ledger. */
export async function GET(req: Request) {
  const ctx = await getContext();
  if (!ctx || !can(ctx.role, "exports")) return new NextResponse("Not allowed", { status: 403 });
  const u = new URL(req.url); const from = u.searchParams.get("from")!, to = u.searchParams.get("to")!;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? "")) return new NextResponse("Bad dates", { status: 400 });
  const [pl, bs, cf, tb] = await Promise.all([profitAndLoss(db, ctx.company.id, from, to), balanceSheet(db, ctx.company.id, to), cashFlow(db, ctx.company.id, from, to), trialBalance(db, ctx.company.id, to)]);
  const wb = new ExcelJS.Workbook(); wb.creator = ctx.company.name;
  const n = (d: { toFixed(n: number): string }) => Number(d.toFixed(2));
  const sheet = (name: string, title: string, rows: (string | number | null)[][]) => {
    const ws = wb.addWorksheet(name); ws.addRow([ctx.company.name]).font = { bold: true, size: 13 }; ws.addRow([title]); ws.addRow([]);
    rows.forEach((r) => { const row = ws.addRow(r); if (typeof r[0] === "string" && /^(Net|Gross|Total|Cash from|Net change)/.test(r[0])) row.font = { bold: true }; });
    ws.getColumn(1).width = 44; ws.getColumn(2).width = 18; ws.getColumn(3).width = 18; ws.getColumn(2).numFmt = "#,##0.00"; ws.getColumn(3).numFmt = "#,##0.00";
  };
  sheet("Profit & Loss", `Profit & loss account, ${from} to ${to}`, [
    ["Sales", n(pl.sales)], ["Less: sales returns", -n(pl.returns)], ["Net sales", n(pl.netSales)],
    ...pl.cogs.map((c) => [`Less: ${c.name}`, -n(c.amount)]), ...pl.direct.map((c) => [`Less: ${c.name}`, -n(c.amount)]), ["Gross profit", n(pl.grossProfit)], [],
    ...pl.otherIncome.map((c) => [`Add: ${c.name}`, n(c.amount)]), ...pl.expenses.map((c) => [`Less: ${c.name}`, -n(c.amount)]), ["Net profit", n(pl.netProfit)]]);
  sheet("Balance Sheet", `Balance sheet as on ${to}`, [
    ["ASSETS"], ...bs.current.map((a) => [a.name, n(a.amount)]), ...bs.fixed.map((a) => [a.name, n(a.amount)]), ["Total assets", n(bs.assets)], [],
    ["LIABILITIES & CAPITAL"], ...bs.currentLiab.map((a) => [a.name, n(a.amount)]), ...bs.loans.map((a) => [a.name, n(a.amount)]),
    ...bs.equity.map((a) => [a.name, n(a.amount)]), ["Profit & loss b/f", n(bs.earlierProfit)], ["Profit for the year", n(bs.profitThisYear)],
    ["Total liabilities & capital", n(bs.liabilities.plus(bs.ownersStake))]]);
  sheet("Cash Flow", `Cash flow statement (indirect), ${from} to ${to}`, [
    ["Net profit", n(cf.indirect.profit)], ["Add: depreciation", n(cf.indirect.depreciation)], ...cf.indirect.wc.map((w) => [w.label, n(w.amount)]),
    ["Cash from operations", n(cf.indirect.operating)], ["Investing activities", n(cf.indirect.investing)], ["Financing activities", n(cf.indirect.financing)],
    ["Net change in cash & bank", n(cf.indirect.net)], ["Opening cash & bank", n(cf.opening)], ["Closing cash & bank", n(cf.closing)]]);
  sheet("Trial Balance", `Trial balance as on ${to}`, [["Account", "Debit", "Credit"],
    ...tb.rows.filter((r) => !r.debitBalance.isZero() || !r.creditBalance.isZero()).map((r) => [`${r.code} ${r.name}`, n(r.debitBalance) || null, n(r.creditBalance) || null]),
    ["Total", n(tb.totalDebit), n(tb.totalCredit)]]);
  await audit(db, { companyId: ctx.company.id, userId: ctx.user.id, action: "export.statements", entityType: "report", after: { from, to } });
  const buf = await wb.xlsx.writeBuffer();
  return new NextResponse(new Uint8Array(buf as ArrayBuffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="Financial-statements_${from}_to_${to}.xlsx"` } });
}
