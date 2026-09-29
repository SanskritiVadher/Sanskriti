import Link from "next/link";
import { requireContext } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";

const READY = [
  { href: "/reports/trial-balance", title: "Are my books balanced?", sub: "Trial balance — every account's balance, and proof that the totals agree." },
  { href: "/reports/day-book", title: "What was recorded?", sub: "Day book — every entry, newest first." },
  { href: "/settings/accounts", title: "Account statements", sub: "Pick any account to see its full statement (ledger) with running balance." },
];
const LATER = [
  ["Profit & loss, balance sheet, cash flow", 6], ["Sales, purchases, stock reports", 4], ["GST reports", 5], ["Ratios and business health", 7],
] as const;

export default async function Reports() {
  await requireContext("view.dashboard");
  return <>
    <PageHeader title="Reports" subtitle="Every figure comes straight from your recorded entries." />
    <div className="grid gap-4 md:grid-cols-3">{READY.map((r) => <Link key={r.href} href={r.href}>
      <Card className="h-full hover:border-brand"><h2 className="text-[17px] font-semibold">{r.title}</h2><p className="mt-1 text-[14px] text-ink-2">{r.sub}</p></Card></Link>)}</div>
    <h2 className="mt-10 mb-3 text-[15px] font-semibold text-ink-2">Coming later</h2>
    <ul className="space-y-1 text-[14px] text-ink-3">{LATER.map(([t, p]) => <li key={t}>{t} — Phase {p}</li>)}</ul>
  </>;
}
