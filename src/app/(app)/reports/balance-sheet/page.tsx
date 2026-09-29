import Link from "next/link";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { balanceSheet, type Bal } from "@/lib/accounting/statements";
import { formatINR, formatINRShort } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { getViewMode } from "@/lib/view-mode";
import { Button, Card, Input, PageHeader, Status } from "@/components/ui";
import type Decimal from "decimal.js";

export default async function BS({ searchParams }: { searchParams: Promise<{ asOf?: string }> }) {
  const ctx = await requireContext("reports.financial");
  const asOf = (await searchParams).asOf || todayIST();
  const b = await balanceSheet(db, ctx.company.id, asOf);
  const accountant = (await getViewMode()) === "accountant";
  const L = (a: Bal) => `/reports/ledger/${a.id}?to=${asOf}`;
  const lbl = (a: Bal) => (accountant ? a.name : a.owner_label);
  const where = [
    { l: "Stock", v: b.current.filter((x) => x.system_key === "INVENTORY").reduce((s, x) => s.plus(x.amount), b.assets.mul(0)) },
    { l: "With customers", v: b.current.filter((x) => x.system_key === "DEBTORS_CONTROL").reduce((s, x) => s.plus(x.amount), b.assets.mul(0)) },
    { l: "Cash & bank", v: b.current.filter((x) => ["1110", "1120"].includes(x.group_code)).reduce((s, x) => s.plus(x.amount), b.assets.mul(0)) },
    { l: "Vehicles & equipment", v: b.fixedAssets },
  ];
  const other = b.assets.minus(where.reduce((s, w) => s.plus(w.v), b.assets.mul(0)));
  if (!other.isZero()) where.push({ l: "GST credit & advances", v: other });

  return <>
    <PageHeader title={accountant ? "Balance sheet" : "What do I own and owe?"} subtitle={`As on ${fmtDate(asOf)}`}
      action={<form className="flex items-end gap-2"><Input type="date" name="asOf" defaultValue={asOf} aria-label="As on" /><Button variant="secondary">Update</Button></form>} />
    <p className="mb-6">{b.balanced ? <Status tone="good">Balanced: what you own = what you owe + your stake</Status> : <Status tone="bad">Does not balance — check System health</Status>}</p>
    {!accountant && <div className="mb-6 grid gap-4 md:grid-cols-3">
      <Card><p className="text-[14px] text-ink-2">The business owns</p><p className="num mt-1 text-[30px] font-semibold">{formatINRShort(b.assets)}</p></Card>
      <Card><p className="text-[14px] text-ink-2">The business owes</p><p className="num mt-1 text-[30px] font-semibold">{formatINRShort(b.liabilities)}</p></Card>
      <Card><p className="text-[14px] text-ink-2">Your stake in the business</p><p className={`num mt-1 text-[30px] font-semibold ${b.ownersStake.lt(0) ? "text-bad" : ""}`}>{formatINRShort(b.ownersStake)}</p>
        <p className="mt-1 text-[13px] text-ink-3">What would be left for you if everything was sold at book value and all dues paid.</p></Card>
    </div>}
    {!accountant && b.assets.gt(0) && <Card className="mb-6"><h2 className="text-[17px] font-semibold">Where your money is</h2>
      <ul className="mt-3 space-y-2">{where.filter((w) => !w.v.isZero()).sort((x, y) => y.v.comparedTo(x.v)).map((w) => <li key={w.l}>
        <div className="flex justify-between text-[15px]"><span>{w.l}</span><span className="num">{formatINRShort(w.v)} · {w.v.div(b.assets).mul(100).toFixed(0)}%</span></div>
        <div className="mt-1 h-2 rounded-full bg-surface-2"><div className="h-2 rounded-full bg-brand" style={{ width: `${Math.max(0, Number(w.v.div(b.assets).mul(100).toFixed(1)))}%` }} /></div></li>)}</ul>
      {where[0].v.plus(where[1].v).div(b.assets).gt(0.6) && <p className="mt-3 text-[14px] text-ink-2">Most of your money is in stock and with customers, not in hand. Collecting dues and not overstocking frees up cash.</p>}
    </Card>}
    <div className="grid gap-4 md:grid-cols-2">
      <Card><h2 className="text-[17px] font-semibold">{accountant ? "Assets" : "What the business owns"}</h2>
        <Section title={accountant ? "Current assets" : "Money & things that turn into money soon"} rows={b.current} total={b.currentAssets} lbl={lbl} L={L} />
        <Section title={accountant ? "Fixed assets" : "Long-term things"} rows={b.fixed} total={b.fixedAssets} lbl={lbl} L={L} />
        <p className="mt-3 flex justify-between border-t-2 border-ink pt-2 font-semibold"><span>Total</span><span className="num">{formatINR(b.assets)}</span></p></Card>
      <Card><h2 className="text-[17px] font-semibold">{accountant ? "Liabilities & capital" : "What the business owes, and your stake"}</h2>
        <Section title={accountant ? "Current liabilities" : "Payments due soon"} rows={b.currentLiab} total={b.currentLiabilities} lbl={lbl} L={L} />
        <Section title={accountant ? "Loans" : "Loans"} rows={b.loans} total={b.loansTotal} lbl={lbl} L={L} />
        <h3 className="mt-4 text-[14px] font-semibold text-ink-2">{accountant ? "Capital account" : "Your stake"}</h3>
        <ul className="text-[15px]">{b.equity.map((a) => <li key={a.id} className="flex justify-between py-0.5"><Link className="hover:underline" href={L(a)}>{lbl(a)}</Link><span className="num">{formatINR(a.amount)}</span></li>)}
          {!b.earlierProfit.isZero() && <li className="flex justify-between py-0.5"><span>{accountant ? "Profit & loss b/f (earlier years)" : "Profit from earlier years"}</span><span className="num">{formatINR(b.earlierProfit)}</span></li>}
          <li className="flex justify-between py-0.5"><Link className="hover:underline" href={`/reports/profit?from=${b.fyStart}&to=${asOf}`}>{accountant ? "Profit for the year" : `Profit this year (since ${fmtDate(b.fyStart)})`}</Link><span className="num">{formatINR(b.profitThisYear)}</span></li></ul>
        <p className="mt-3 flex justify-between border-t-2 border-ink pt-2 font-semibold"><span>Total</span><span className="num">{formatINR(b.liabilities.plus(b.ownersStake))}</span></p></Card>
    </div>
  </>;
}
function Section({ title, rows, total, lbl, L }: { title: string; rows: Bal[]; total: Decimal; lbl: (a: Bal) => string; L: (a: Bal) => string }) {
  if (!rows.length) return null;
  return <><h3 className="mt-4 text-[14px] font-semibold text-ink-2">{title}</h3>
    <ul className="text-[15px]">{rows.map((a) => <li key={a.id} className="flex justify-between py-0.5"><Link className="hover:underline" href={L(a)}>{lbl(a)}</Link>
      <span className={`num ${a.amount.lt(0) ? "text-warn" : ""}`}>{formatINR(a.amount)}</span></li>)}</ul>
    <p className="flex justify-between border-t border-line pt-1 text-[14px] text-ink-2"><span>Subtotal</span><span className="num">{formatINR(total)}</span></p></>;
}
