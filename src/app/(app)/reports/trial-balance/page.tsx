import Link from "next/link";
import { requireContext } from "@/lib/session";
import { db } from "@/db";
import { trialBalance, naturalBalance } from "@/lib/accounting/reports";
import { formatINR } from "@/lib/money";
import { todayIST, fmtDate } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Button, Card, Input, Notice, PageHeader } from "@/components/ui";

const TOP: Record<string, { label: string; why: string }> = {
  ASSET: { label: "What the business owns", why: "Cash, bank, money customers owe, stock, GST you can claim." },
  LIABILITY: { label: "What the business owes", why: "Suppliers, loans, GST collected that must be paid." },
  EQUITY: { label: "Owner's money in the business", why: "Capital put in, plus opening balances." },
  INCOME: { label: "Money earned", why: "Sales and other income." },
  EXPENSE: { label: "Money spent", why: "Cost of goods sold and running costs." },
};

export default async function TB({ searchParams }: { searchParams: Promise<{ asOf?: string; all?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const asOf = sp.asOf || todayIST();
  const accountant = (await getViewMode()) === "accountant";
  const tb = await trialBalance(db, ctx.company.id, asOf);
  const rows = sp.all ? tb.rows : tb.rows.filter((r) => !r.debitBalance.isZero() || !r.creditBalance.isZero());
  const empty = tb.totalDebit.isZero();

  return <>
    <PageHeader title={accountant ? "Trial balance" : "Are my books balanced?"} subtitle={`As on ${fmtDate(asOf)}`} />
    <form className="mb-6 flex flex-wrap items-end gap-3">
      <label className="text-[14px]">As on<Input type="date" name="asOf" defaultValue={asOf} className="mt-1" /></label>
      <label className="flex items-center gap-2 pb-3 text-[14px]"><input type="checkbox" name="all" value="1" defaultChecked={!!sp.all} /> Show accounts with zero balance</label>
      <Button variant="secondary">Update</Button>
    </form>

    {empty ? <Notice tone="info" title="Nothing recorded up to this date." /> :
      tb.balanced ? <Notice tone="good" title={`Yes. Your books balance: total debits and total credits are both ${formatINR(tb.totalDebit)}.`}>
        {!accountant && "Every rupee recorded has two sides, and both sides add up. This is the basic check that nothing is missing or double-counted."}</Notice>
      : <Notice tone="bad" title="The totals don't agree. This should never happen.">Debits {formatINR(tb.totalDebit)} vs credits {formatINR(tb.totalCredit)}. Open Settings → System health.</Notice>}

    {!empty && (accountant ? <Card className="mt-6 overflow-x-auto">
      <table className="w-full text-[14px]">
        <caption className="sr-only">Trial balance</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Code</th><th className="pb-2">Account</th><th className="pb-2">Group</th>
          <th className="pb-2 text-right">Debit</th><th className="pb-2 text-right">Credit</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.accountId} className="border-t border-line">
          <td className="num py-2 text-ink-3">{r.code}</td>
          <td><Link className="hover:underline" href={`/reports/ledger/${r.accountId}?to=${asOf}`}>{r.name}</Link></td>
          <td className="text-ink-2">{r.groupName}</td>
          <td className="num text-right">{r.debitBalance.isZero() ? "" : formatINR(r.debitBalance)}</td>
          <td className="num text-right">{r.creditBalance.isZero() ? "" : formatINR(r.creditBalance)}</td></tr>)}</tbody>
        <tfoot><tr className="border-t-2 border-ink font-semibold"><td colSpan={3} className="py-2">Total</td>
          <td className="num text-right">{formatINR(tb.totalDebit)}</td><td className="num text-right">{formatINR(tb.totalCredit)}</td></tr></tfoot>
      </table></Card>
    : <div className="mt-6 grid gap-4 md:grid-cols-2">{Object.entries(TOP).map(([nature, t]) => {
        const list = rows.filter((r) => r.nature === nature);
        if (!list.length) return null;
        const total = list.reduce((s, r) => s.plus(naturalBalance(r.nature, r.totalDebit, r.totalCredit)), naturalBalance(list[0].nature, 0, 0));
        return <Card key={nature}>
          <div className="flex items-baseline justify-between"><h2 className="text-[17px] font-semibold">{t.label}</h2><span className="num font-semibold">{formatINR(total)}</span></div>
          <p className="mb-3 text-[13px] text-ink-3">{t.why}</p>
          <ul className="text-[15px]">{list.map((r) => { const b = naturalBalance(r.nature, r.totalDebit, r.totalCredit);
            return <li key={r.accountId} className="flex justify-between py-1">
              <Link className="hover:underline" href={`/reports/ledger/${r.accountId}?to=${asOf}`}>{r.ownerLabel}</Link>
              <span className={`num ${b.isNegative() ? "text-warn" : ""}`}>{formatINR(b)}</span></li>; })}</ul>
        </Card>; })}</div>)}
  </>;
}
