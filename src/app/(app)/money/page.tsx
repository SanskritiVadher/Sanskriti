import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { moneyPosition } from "@/lib/accounting/reports";
import { formatINR, formatINRShort } from "@/lib/money";
import { todayIST, fmtDate } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Card, LinkButton, PageHeader, Status } from "@/components/ui";

const TYPE_LABEL: Record<string, string> = {
  OPENING: "Opening balances", JOURNAL: "Adjustment", RECEIPT: "Money in", PAYMENT: "Money out",
  CONTRA: "Cash ↔ bank", REVERSAL: "Cancellation",
};

export default async function Money() {
  const ctx = await requireContext("view.dashboard");
  const accountant = (await getViewMode()) === "accountant";
  const today = todayIST();
  const pos = await moneyPosition(db, ctx.company.id, today);
  const recent = await db.query.journalEntries.findMany({
    where: and(eq(schema.journalEntries.companyId, ctx.company.id)), orderBy: [desc(schema.journalEntries.createdAt)], limit: 8 });
  const negatives = pos.accounts.filter((a) => a.balance.isNegative());

  return <>
    <PageHeader title="Money" subtitle="Where is my money?" action={can(ctx.role, "money.record") &&
      <div className="flex flex-wrap gap-2">
        <LinkButton href="/money/new?type=receipt">+ Money in</LinkButton>
        <LinkButton href="/money/new?type=payment" variant="secondary">− Money out</LinkButton>
        <LinkButton href="/money/new?type=contra" variant="secondary">⇄ Cash ↔ bank</LinkButton>
        <LinkButton href="/money/bank" variant="secondary">Bank statements</LinkButton>
      </div>} />

    <Card className="mb-6">
      <p className="text-[14px] text-ink-2">Cash and bank today</p>
      <p className="num mt-1 text-[36px] font-semibold tracking-tight">{formatINRShort(pos.total)}</p>
      <p className="mt-1 text-ink-2">
        {pos.total.isZero() && recent.length === 0
          ? "Nothing recorded yet. Add your opening cash and bank balances to start."
          : `This is the money the business can use right now, across ${pos.accounts.length} cash and bank account${pos.accounts.length === 1 ? "" : "s"}.`}
      </p>
      {negatives.length > 0 && <p className="mt-3"><Status tone="warn">{negatives.map((n) => n.ownerLabel).join(", ")} below zero</Status>
        <span className="ml-2 text-[14px] text-ink-2">This usually means an overdraft, or a payment was recorded before the money came in.</span></p>}
      <ul className="mt-5 divide-y divide-line">{pos.accounts.map((a) =>
        <li key={a.accountId} className="flex items-center justify-between py-3">
          <Link href={`/reports/ledger/${a.accountId}`} className="hover:underline">{accountant ? a.name : a.ownerLabel}</Link>
          <span className={`num ${a.balance.isNegative() ? "text-bad" : ""}`}>{formatINR(a.balance)}</span></li>)}
      </ul>
      {!ctx.company.booksBeginOn && can(ctx.role, "ledger.post_manual") &&
        <p className="mt-4 text-[14px]"><Link className="text-brand underline" href="/settings/opening">Add opening balances →</Link></p>}
    </Card>

    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[18px] font-semibold">Recent entries</h2>
        <div className="flex gap-3 text-[14px]">
          {can(ctx.role, "money.record") && <Link className="text-brand underline" href="/money/fix">Fix a mistake</Link>}
          <Link className="text-brand underline" href="/reports/day-book">All entries</Link>
        </div>
      </div>
      {recent.length === 0 ? <p className="text-ink-2">No entries yet.</p> :
        <ul className="divide-y divide-line">{recent.map((e) =>
          <li key={e.id}><Link href={`/reports/entry/${e.id}`} className="flex items-center justify-between gap-4 py-3 hover:bg-surface-2">
            <div><p>{e.narration || TYPE_LABEL[e.voucherType] || e.voucherType}</p>
              <p className="text-[13px] text-ink-3">{fmtDate(e.entryDate)} · {TYPE_LABEL[e.voucherType] ?? e.voucherType}{accountant && ` · ${e.voucherNumber}`}
                {e.status === "REVERSED" && " · cancelled"}</p></div>
            <span className={`num ${e.status === "REVERSED" ? "text-ink-3 line-through" : ""}`}>{formatINR(e.totalAmount)}</span>
          </Link></li>)}</ul>}
    </Card>
  </>;
}
