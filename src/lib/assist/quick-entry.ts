/**
 * Quick entry: turns a typed sentence ("Ramesh paid 5000 cash", "rent 12000 bank", "chai 200")
 * into a PROPOSED entry. Nothing is posted here — the owner reviews every field and confirms.
 * Rule-based (no AI): it only understands the patterns below, and says plainly what it assumed or couldn't tell.
 */
import Decimal from "decimal.js";

export type QParty = { id: string; name: string; type: "CUSTOMER" | "SUPPLIER" };
export type QAccount = { id: string; systemKey: string | null; label: string; groupCode: string };
export type Kind = "CUSTOMER_PAYMENT" | "SUPPLIER_PAYMENT" | "EXPENSE" | "DRAWINGS" | "MONEY_IN" | "DEPOSIT" | "WITHDRAW";
export type Proposal = {
  kind: Kind | null; amount: string | null; date: string; mode: "CASH" | "BANK" | null;
  partyId: string | null; partyCandidates: QParty[]; accountId: string | null;
  assumed: string[]; unclear: string[];
};

const EXPENSE_WORDS: [string, RegExp][] = [
  ["RENT", /\b(rent|kiraya|kiraaya)\b/],
  ["SALARIES", /\b(salary|salaries|wages?|tankhwah|tankha|pagar|staff pay)\b/],
  ["ELECTRICITY", /\b(electricity|bijli|light bill|power bill)\b/],
  ["TELEPHONE", /\b(phone|mobile|recharge|internet|wifi|broadband)\b/],
  ["FREIGHT_OUTWARD", /\b(delivery|transport|freight|bhada|bhaada|tempo|courier|auto fare|porter|hamali)\b/],
  ["BANK_CHARGES", /\b(bank charges?|charges deducted|sms charges)\b/],
  ["INTEREST_EXPENSE", /\b(interest|byaj|byaaj)\b/],
  ["OFFICE_EXPENSES", /\b(tea|chai|snacks?|stationery|office|cleaning|water|paper|pen|xerox|printout)\b/],
];
const DRAWINGS = /\b(drawings?|for home|ghar ke? liye|ghar kharch|personal|owner took|i took|maine liya)\b/;
const IN_WORDS = /\b(received|recieved|receive|got|collected|mila|mile|mili|aaya|aya|aayi|jama hua|credited)\b/;
const OUT_WORDS = /\b(paid|pay|gave|given|diya|diye|de diya|spent|kharcha|kharch|sent|bheja|debited)\b/;
const CASH = /\b(cash|nakad|naqad|nagad|nakd)\b/;
const BANK = /\b(bank|upi|gpay|google pay|phonepe|paytm|neft|rtgs|imps|cheque|check|chq|online|transfer)\b/;
const DEPOSIT = /\b(deposit(ed)?|bank me(in)? jama|cash to bank|jama kiya|jama kiye)\b/;
const WITHDRAW = /\b(withdr[ae]w(n|al)?|nikala|nikale|atm|bank to cash|cash nikal)\b/;
const CAPITAL = /\b(capital|invested|put in|lagaya|lagaye|own money)\b/;
const LOAN = /\b(loan|karz|karza|udhar liya)\b/;
const SUFFIX = new Set(["traders", "trader", "enterprises", "enterprise", "sons", "and", "co", "company", "store", "stores", "agency", "agencies", "ji", "bhai", "shop", "the", "mart", "pvt", "ltd", "private", "limited", "electricals", "electronics", "battery", "batteries", "house", "centre", "center"]);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]+/g, " ").split(/\s+/).filter(Boolean);

function parseAmount(t: string): string | null {
  // Remove dates first so "12/09" isn't read as an amount.
  const s = t.replace(/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/g, " ").replace(/(₹|rs\.?|inr)\s*/gi, " ");
  const m = s.match(/(\d[\d,]*(?:\.\d{1,2})?)\s*(k|thousand|hazar|hajar|hazaar|lakh|lakhs|lac|lacs)?\b/i);
  if (!m) return null;
  let v = new Decimal(m[1].replace(/,/g, ""));
  const u = (m[2] ?? "").toLowerCase();
  if (["k", "thousand", "hazar", "hajar", "hazaar"].includes(u)) v = v.mul(1000);
  if (u.startsWith("lakh") || u.startsWith("lac")) v = v.mul(100000);
  return v.gt(0) ? v.toDecimalPlaces(2).toString() : null;
}

function parseDate(t: string, today: string): { date: string; said: string | null } {
  const shift = (n: number) => new Date(Date.parse(today + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);
  if (/\b(yesterday|kal)\b/.test(t)) return { date: shift(-1), said: "yesterday" };
  if (/\b(day before yesterday|parso)\b/.test(t)) return { date: shift(-2), said: "day before yesterday" };
  const m = t.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (m) {
    const d = +m[1], mo = +m[2];
    let y = m[3] ? +m[3] : +today.slice(0, 4);
    if (y < 100) y += 2000;
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && new Date(iso + "T00:00:00Z").toISOString().slice(0, 10) === iso;
    if (ok) return { date: !m[3] && iso > today ? `${y - 1}${iso.slice(4)}` : iso, said: m[0] };
  }
  return { date: today, said: null };
}

function matchParties(t: string, parties: QParty[]): QParty[] {
  const tw = words(t);
  const scored = parties.map((p) => {
    const core = words(p.name).filter((w) => w.length >= 3 && !SUFFIX.has(w));
    // An exact word counts fully; a partial word ("moh" / "mohant") counts less, so "Mohan" beats "Mohanty" for "mohan".
    const hit = core.reduce((n, w) => n + (tw.includes(w) ? 1 : tw.some((x) => (x.length >= 4 && w.startsWith(x)) || (w.length >= 4 && x.startsWith(w))) ? 0.6 : 0), 0);
    return { p, hit, score: core.length ? hit / core.length : 0 };
  }).filter((x) => x.hit > 0);
  if (!scored.length) return [];
  const best = Math.max(...scored.map((x) => x.score));
  const top = scored.filter((x) => x.score === best);
  const maxHit = Math.max(...top.map((x) => x.hit));
  return top.filter((x) => x.hit === maxHit).map((x) => x.p);
}

export function parseQuickEntry(text: string, ctx: { parties: QParty[]; accounts: QAccount[]; today: string }): Proposal {
  const t = ` ${text.toLowerCase()} `;
  const assumed: string[] = [], unclear: string[] = [];
  const amount = parseAmount(text);
  if (!amount) unclear.push("How much? I couldn't find an amount.");
  const { date, said } = parseDate(t, ctx.today);
  if (!said) assumed.push("Date: today.");

  const cash = CASH.test(t), bank = BANK.test(t);
  let mode: Proposal["mode"] = cash && !bank ? "CASH" : bank && !cash ? "BANK" : null;
  const acc = (k: string) => ctx.accounts.find((a) => a.systemKey === k)?.id ?? null;

  let kind: Kind | null = null, accountId: string | null = null, partyId: string | null = null;
  let candidates: QParty[] = [];
  if (DEPOSIT.test(t) && !OUT_WORDS.test(t.replace(DEPOSIT, ""))) { kind = "DEPOSIT"; mode = null; }
  else if (WITHDRAW.test(t)) { kind = "WITHDRAW"; mode = null; }

  if (!kind) {
    const found = matchParties(t, ctx.parties);
    const isIn = IN_WORDS.test(t), isOut = OUT_WORDS.test(t);
    // Direction decides which list wins when a name matches both a customer and a supplier.
    const pick = (ty: QParty["type"]) => found.filter((p) => p.type === ty);
    let list = found;
    if (found.length > 1) {
      const c = pick("CUSTOMER"), s = pick("SUPPLIER");
      if (isIn && !isOut && c.length) list = c; else if (isOut && !isIn && s.length) list = s;
    }
    candidates = list;
    if (list.length === 1) {
      const p = list[0]; partyId = p.id;
      // "Ramesh paid 5000" means Ramesh paid US; for a supplier "paid Gupta 5000" means we paid.
      kind = p.type === "CUSTOMER" ? "CUSTOMER_PAYMENT" : "SUPPLIER_PAYMENT";
      if (p.type === "CUSTOMER" && isOut && /\b(to|ko)\b/.test(t) && !isIn) unclear.push(`${p.name} is a customer — did you pay them (a refund)? This screen records money received from them.`);
    } else if (list.length > 1) {
      kind = list.every((p) => p.type === "CUSTOMER") ? "CUSTOMER_PAYMENT" : list.every((p) => p.type === "SUPPLIER") ? "SUPPLIER_PAYMENT" : null;
      unclear.push(`Which one: ${list.map((p) => p.name).join(" or ")}?`);
    }
    if (!kind && !list.length) {
      if (DRAWINGS.test(t)) { kind = "DRAWINGS"; accountId = acc("DRAWINGS"); }
      else if (CAPITAL.test(t) && !isOut) { kind = "MONEY_IN"; accountId = acc("CAPITAL"); }
      else if (LOAN.test(t) && !isOut) { kind = "MONEY_IN"; accountId = acc("BANK_LOAN"); assumed.push("Treated as a loan received."); }
      else {
        const e = EXPENSE_WORDS.find(([, re]) => re.test(t));
        if (e) { kind = "EXPENSE"; accountId = acc(e[0]); if (e[0] === "FREIGHT_OUTWARD") assumed.push("Transport counted as delivery on sales. If it was for bringing stock in, choose 'Transport on purchases'."); }
        else if (isIn) { kind = "MONEY_IN"; unclear.push("Money in from whom? No customer name matched."); }
        else if (isOut) { kind = "EXPENSE"; unclear.push("Paid for what? No supplier name or expense type matched."); }
        else unclear.push("I couldn't tell whether money came in or went out.");
      }
    }
  }
  if (!mode && kind !== "DEPOSIT" && kind !== "WITHDRAW") unclear.push("Cash or bank? Please choose.");
  return { kind, amount, date, mode, partyId, partyCandidates: candidates, accountId, assumed, unclear };
}
