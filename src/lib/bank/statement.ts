/**
 * Reads a bank statement exported from net banking (CSV, Excel .xlsx, or the ".xls" that many Indian banks
 * send which is really an HTML or tab-separated table). Finds the header row, maps columns, reads Indian
 * day-first dates, and checks the running balance so a damaged file is caught before anything is saved.
 */
import Decimal from "decimal.js";
import { readTable } from "@/lib/services/importer";
import { UserFacingError } from "@/lib/errors";

export type StmtLine = { date: string; narration: string; ref: string | null; withdrawal: string; deposit: string; balance: string | null };
export type ParsedStatement = { lines: StmtLine[]; skipped: number; opening: string | null; closing: string | null; balanceBreaks: number[]; columns: Record<string, string> };

const norm = (s: string) => s.toLowerCase().replace(/[\s_.:*()/\\-]+/g, " ").trim();
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function parseBankDate(raw: string): string | null {
  const s = raw.trim().replace(/\s+\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?$/i, "");
  let d: number, m: number, y: number;
  let x = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (x) { y = +x[1]; m = +x[2]; d = +x[3]; }
  else if ((x = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/))) { d = +x[1]; m = +x[2]; y = +x[3]; }
  else if ((x = s.match(/^(\d{1,2})[\s/-]([A-Za-z]{3,4})[a-z]*[\s/,-]+(\d{2,4})$/))) { d = +x[1]; m = MONTHS[x[2].toLowerCase()] ?? 0; y = +x[3]; }
  else return null;
  if (y < 100) y += 2000;
  const iso = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (m < 1 || m > 12 || d < 1 || d > 31 || Number.isNaN(Date.parse(iso)) || new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/** "1,23,456.78", "₹ 500", "500.00 Cr", "(200)" → Decimal; blank / "-" → 0. */
export function parseBankAmount(raw: string): Decimal | null {
  let s = (raw ?? "").trim();
  if (!s || s === "-" || s === "--") return new Decimal(0);
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/₹|inr|rs\.?/gi, "").replace(/,/g, "").trim();
  const suf = s.match(/\s*(cr|dr)\.?$/i);
  if (suf) { if (suf[1].toLowerCase() === "dr") neg = !neg; s = s.slice(0, suf.index).trim(); }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const v = new Decimal(s);
  return neg ? v.neg() : v;
}

const COLS: Record<string, string[]> = {
  date: ["txn date", "transaction date", "tran date", "date", "posting date", "value date"],
  narration: ["narration", "description", "particulars", "transaction remarks", "remarks", "details", "transaction details", "transaction description"],
  ref: ["chq ref no", "chq no", "cheque no", "ref no", "reference no", "chq ref number", "cheque number", "ref no cheque no", "utr", "chq no ref no", "transaction id"],
  withdrawal: ["withdrawal amt", "withdrawal amount", "withdrawal", "withdrawals", "debit", "debit amount", "dr amount", "debit amt", "dr"],
  deposit: ["deposit amt", "deposit amount", "deposit", "deposits", "credit", "credit amount", "cr amount", "credit amt", "cr"],
  balance: ["closing balance", "balance", "available balance", "running balance", "balance amt", "balance inr"],
  amount: ["amount", "transaction amount", "amount inr"],
  drcr: ["dr cr", "cr dr", "type", "debit credit", "transaction type"],
};

function findHeader(table: string[][]) {
  for (let r = 0; r < Math.min(table.length, 40); r++) {
    const cells = table[r].map(norm);
    const pick = (k: string) => { for (const a of COLS[k]) { const i = cells.findIndex((c) => c === a || c.replace(/ inr$| rs$/, "") === a); if (i >= 0) return i; } return -1; };
    const idx = Object.fromEntries(Object.keys(COLS).map((k) => [k, pick(k)])) as Record<string, number>;
    // Prefer the transaction date over value date when both exist.
    if (idx.date >= 0 && idx.narration >= 0 && ((idx.withdrawal >= 0 && idx.deposit >= 0) || (idx.amount >= 0 && idx.drcr >= 0))) return { row: r, idx, head: table[r] };
  }
  return null;
}

function sniffTable(buf: Buffer): string[][] | null {
  const text = buf.toString("utf8").replace(/^﻿/, "");
  if (/<table/i.test(text)) {
    const rows: string[][] = [];
    for (const tr of text.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim());
      if (cells.length) rows.push(cells);
    }
    return rows;
  }
  if (!text.includes("\u0000") && text.includes("\t")) return text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("\t").map((c) => c.replace(/^"|"$/g, "").trim()));
  return null;
}

export async function readStatementFile(buf: Buffer, fileName: string): Promise<string[][]> {
  if (buf.length > 4 * 1024 * 1024) throw new UserFacingError("File is larger than 4 MB. Download a shorter period (e.g. one quarter).");
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xls") || lower.endsWith(".txt")) {
    const t = sniffTable(buf);
    if (t) return t;
    if (lower.endsWith(".xls")) throw new UserFacingError("This is an old-style Excel (.xls) file, which can't be read safely here. In your net banking, download the statement as CSV — or open this file in Excel and Save As .xlsx.");
  }
  return readTable(buf, fileName);
}

export function parseStatement(table: string[][]): ParsedStatement {
  const h = findHeader(table);
  if (!h) throw new UserFacingError("Couldn't find the column headings (Date, Narration/Description, Withdrawal/Debit, Deposit/Credit). Make sure this is the transactions statement, not a summary.");
  const { idx } = h;
  const lines: StmtLine[] = [];
  let skipped = 0;
  for (const row of table.slice(h.row + 1)) {
    const date = parseBankDate(row[idx.date] ?? "");
    if (!date) { if (row.some((c) => c && c.trim())) skipped++; continue; }
    let w: Decimal | null, d: Decimal | null;
    if (idx.withdrawal >= 0 && idx.deposit >= 0) { w = parseBankAmount(row[idx.withdrawal] ?? ""); d = parseBankAmount(row[idx.deposit] ?? ""); }
    else {
      const a = parseBankAmount(row[idx.amount] ?? ""), t = norm(row[idx.drcr] ?? "");
      if (!a) { skipped++; continue; }
      const isDr = /^(dr|d|debit|withdrawal)/.test(t), isCr = /^(cr|c|credit|deposit)/.test(t);
      if (!isDr && !isCr) { skipped++; continue; }
      w = isDr ? a.abs() : new Decimal(0); d = isCr ? a.abs() : new Decimal(0);
    }
    if (!w || !d || (w.isZero() && d.isZero())) { skipped++; continue; }
    if (w.lt(0) || d.lt(0)) { const net = d.minus(w); w = net.lt(0) ? net.neg() : new Decimal(0); d = net.gt(0) ? net : new Decimal(0); }
    const bal = idx.balance >= 0 ? parseBankAmount(row[idx.balance] ?? "") : null;
    lines.push({ date, narration: (row[idx.narration] ?? "").replace(/\s+/g, " ").trim() || "(no description)", ref: idx.ref >= 0 ? (row[idx.ref] ?? "").trim() || null : null,
      withdrawal: w.toFixed(2), deposit: d.toFixed(2), balance: bal && (row[idx.balance] ?? "").trim() ? bal.toFixed(2) : null });
  }
  if (!lines.length) throw new UserFacingError("No transactions found under the headings.");
  // Newest-first statements are flipped so balances run forward.
  if (lines[0].date > lines[lines.length - 1].date) lines.reverse();
  const balanceBreaks: number[] = [];
  let opening: string | null = null;
  if (lines.every((l) => l.balance != null)) {
    opening = new Decimal(lines[0].balance!).minus(lines[0].deposit).plus(lines[0].withdrawal).toFixed(2);
    for (let i = 1; i < lines.length; i++) {
      const exp = new Decimal(lines[i - 1].balance!).plus(lines[i].deposit).minus(lines[i].withdrawal);
      if (!exp.eq(lines[i].balance!)) balanceBreaks.push(i + 1);
    }
  }
  const columns = Object.fromEntries(Object.entries(idx).filter(([, i]) => i >= 0).map(([k, i]) => [k, h.head[i]]));
  return { lines, skipped, opening, closing: lines[lines.length - 1].balance, balanceBreaks, columns };
}
