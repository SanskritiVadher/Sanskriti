import Link from "next/link";
import { requireContext } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";

const READY = [
  { href: "/reports/profit", title: "Did I make money?", sub: "Profit & loss, with why it changed from last period." },
  { href: "/reports/balance-sheet", title: "What do I own and owe?", sub: "Balance sheet, and where your money is sitting." },
  { href: "/reports/cash-flow", title: "Where did my cash go?", sub: "Cash flow: money in and out, by type." },
  { href: "/reports/trial-balance", title: "Are my books balanced?", sub: "Trial balance — every account's balance, and proof that the totals agree." },
  { href: "/reports/day-book", title: "What was recorded?", sub: "Day book — every entry, newest first." },
  { href: "/settings/accounts", title: "Account statements", sub: "Pick any account to see its full statement (ledger) with running balance." },
  { href: "/gst", title: "Is my GST in order?", sub: "GST position, GSTR-1 / 3B figures, 2B matching." },
  { href: "/reports/health", title: "How is my business doing?", sub: "Six plain answers: cash, customers, profit, stock, borrowing, books." },
  { href: "/reports/ratios", title: "How healthy are my numbers?", sub: "21 ratios in plain language, against your own history and targets." },
  { href: "/reports/profitability", title: "Where do I make money?", sub: "Profit by product, brand, customer and salesperson." },
  { href: "/inventory/insights", title: "What should I reorder?", sub: "Slow, dead and low stock, with reorder suggestions." },
  { href: "/assistant/checks", title: "Anything unusual?", sub: "Possible duplicates, below-cost sales, large cash, back-dated entries." },
  { href: "/money/bank", title: "Does my bank agree?", sub: "Upload a bank statement; match it line by line with your books." },
  { href: "/brief/week", title: "How did this week go?", sub: "This week against last week: sales, profit, collections, costs." },
  { href: "/reports/audit", title: "Who did what", sub: "Audit trail of every change, with before and after." },
];
const LATER = [
  ["Asking questions in plain words (needs an AI key)", 8], ["Backups, security review, speed", 10],
] as const;

export default async function Reports() {
  await requireContext("view.dashboard");
  return <>
    <PageHeader title="Reports" subtitle="Every figure comes straight from your recorded entries." />
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{READY.map((r) => <Link key={r.href} href={r.href}>
      <Card className="h-full hover:border-brand"><h2 className="text-[17px] font-semibold">{r.title}</h2><p className="mt-1 text-[14px] text-ink-2">{r.sub}</p></Card></Link>)}</div>
    <h2 className="mt-10 mb-3 text-[15px] font-semibold text-ink-2">Coming later</h2>
    <ul className="space-y-1 text-[14px] text-ink-3">{LATER.map(([t, p]) => <li key={t}>{t} — Phase {p}</li>)}</ul>
  </>;
}
