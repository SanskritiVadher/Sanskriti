import { ruleFor, trustedRule } from "@/lib/services/gst";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { stockOf, productMovements, ADJUST_REASONS } from "@/lib/services/inventory";
import { formatINR, D } from "@/lib/money";
import { fmtDate, todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, LinkButton, Notice, PageHeader, Select, Status } from "@/components/ui";
import { adjustStockAction } from "@/app/actions-phase3";

const TYPE: Record<string, string> = { OPENING: "Opening stock", ADJUSTMENT_IN: "Added (correction)", ADJUSTMENT_OUT: "Removed (correction)",
  PURCHASE: "Purchased", SALE: "Sold", PURCHASE_RETURN: "Returned to supplier", SALES_RETURN: "Returned by customer", TRANSFER_IN: "Transfer in", TRANSFER_OUT: "Transfer out" };

export default async function Product({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext("view.dashboard");
  const { id } = await params;
  const sp = await searchParams;
  const p = await db.query.products.findFirst({ where: and(eq(schema.products.id, id), eq(schema.products.companyId, ctx.company.id)) });
  if (!p) notFound();
  const [s, moves, brand] = await Promise.all([stockOf(db, id), productMovements(db, ctx.company.id, id),
    p.brandId ? db.query.brands.findFirst({ where: eq(schema.brands.id, p.brandId) }) : null]);
  const low = p.reorderLevel && s.qty.lte(p.reorderLevel);
  const margin = p.dealerPrice && s.qty.gt(0) ? D(p.dealerPrice).minus(s.avgCost) : null;

  const rateRule = trustedRule(ruleFor(await db.query.gstRateRules.findMany({ where: eq(schema.gstRateRules.companyId, ctx.company.id) }), p.hsn, todayIST()));
  return <>
    <PageHeader title={p.name} subtitle={[brand?.name, p.sku, p.hsn && `HSN ${p.hsn}`].filter(Boolean).join(" · ")}
      action={can(ctx.role, "inventory.adjust") && <LinkButton href={`/inventory/${id}/edit`} variant="secondary">Edit</LinkButton>} />
    {sp.saved && <div className="mb-4"><Notice tone="good" title="Saved." /></div>}
    {sp.adjusted && <div className="mb-4"><Notice tone="good" title="Stock corrected. The accounts were updated too." /></div>}
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}

    <div className="mb-6 grid gap-4 md:grid-cols-3">
      <Card><p className="text-[14px] text-ink-2">In stock</p><p className="num mt-1 text-[30px] font-semibold">{s.qty.toString()} {p.unit}</p>
        <p className="mt-1">{s.qty.lte(0) ? <Status tone="bad">Out of stock</Status> : low ? <Status tone="warn">Low: reorder level is {D(p.reorderLevel!).toString()}</Status> : <Status tone="good">OK</Status>}</p></Card>
      <Card><p className="text-[14px] text-ink-2">Value</p><p className="num mt-1 text-[30px] font-semibold">{formatINR(s.value)}</p>
        <p className="mt-1 text-[14px] text-ink-2">{s.qty.gt(0) ? `Average cost ${formatINR(s.avgCost)} each` : "No stock"}</p></Card>
      <Card><p className="text-[14px] text-ink-2">Profit per piece at dealer price</p>
        {margin ? <><p className={`num mt-1 text-[30px] font-semibold ${margin.lt(0) ? "text-bad" : ""}`}>{formatINR(margin)}</p>
          <p className="mt-1 text-[14px] text-ink-2">{D(p.dealerPrice!).isZero() ? "" : `${margin.div(p.dealerPrice!).mul(100).toFixed(1)}% of the dealer price, before GST`}</p></>
          : <p className="mt-2 text-[14px] text-ink-2">Add a dealer price and stock to see this.</p>}</Card>
    </div>

    <Card className="mb-6"><dl className="grid gap-2 text-[15px] sm:grid-cols-3">
      {([["Purchase price", p.purchasePrice], ["Dealer price", p.dealerPrice], ["Wholesale price", p.wholesalePrice], ["Retail price", p.retailPrice], ["MRP", p.mrp], ["Lowest allowed", p.minSellingPrice]] as const)
        .map(([l, v]) => <div key={l}><dt className="text-[13px] text-ink-3">{l}</dt><dd className="num">{v ? formatINR(v) : "—"}</dd></div>)}
      <div><dt className="text-[13px] text-ink-3">GST rate</dt><dd>{p.gstRate ? `${D(p.gstRate).toString()}%` : "—"} {p.gstRate && (p.gstRateStatus === "USER_CONFIRMED" ? <Status tone="good">Confirmed by you</Status> : <Status tone="warn">Not confirmed</Status>)}
        {rateRule && p.gstRate && !D(rateRule.rate).eq(p.gstRate) && <span className="mt-1 block text-[13px] text-bad">Your checked rate table says {D(rateRule.rate).toString()}% for HSN {rateRule.hsnPrefix}. <Link className="underline" href="/gst/rates#products">Fix</Link></span>}</dd></div>
      <div><dt className="text-[13px] text-ink-3">Warranty</dt><dd>{p.warrantyMonths ? `${p.warrantyMonths} months` : "—"}</dd></div>
      <div><dt className="text-[13px] text-ink-3">Serial numbers</dt><dd>{p.trackSerial ? "Tracked" : "Not tracked"}</dd></div>
    </dl></Card>

    {can(ctx.role, "inventory.adjust") && <Card className="mb-6">
      <h2 className="text-[17px] font-semibold">Correct the stock</h2>
      <p className="mb-4 text-[14px] text-ink-2">For damage, loss, stock taken home, or when a physical count doesn&rsquo;t match. Purchases and sales will update stock automatically (Phase 4).</p>
      <form action={adjustStockAction} className="grid gap-4 sm:grid-cols-5">
        <input type="hidden" name="productId" value={id} />
        <Field label="What happened"><Select name="reason" required>{Object.entries(ADJUST_REASONS).map(([k, r]) => <option key={k} value={k}>{r.dir < 0 ? "− " : "+ "}{r.label}</option>)}</Select></Field>
        <Field label="Quantity"><Input name="qty" inputMode="decimal" required /></Field>
        <Field label="Date"><Input type="date" name="date" defaultValue={todayIST()} required /></Field>
        {s.qty.lte(0) && <Field label="Cost per unit (₹)" hint="Needed when adding with no stock"><Input name="unitCost" inputMode="decimal" /></Field>}
        <Field label="Note"><Input name="note" /></Field>
        <div className="sm:col-span-5"><Button variant="secondary">Save correction</Button></div>
      </form>
    </Card>}

    <Card className="overflow-x-auto">
      <h2 className="mb-3 text-[17px] font-semibold">Stock history</h2>
      {moves.length === 0 ? <p className="text-ink-2">No movements yet.</p> :
      <table className="w-full text-[14px]"><caption className="sr-only">Stock movements</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Date</th><th className="pb-2">What</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Value</th><th className="pb-2">Note</th></tr></thead>
        <tbody>{moves.map((m) => <tr key={m.id} className="border-t border-line">
          <td className="py-2 whitespace-nowrap">{fmtDate(m.date)}</td>
          <td>{m.entryId ? <Link className="hover:underline" href={`/reports/entry/${m.entryId}`}>{TYPE[m.type]}</Link> : TYPE[m.type]}</td>
          <td className={`num text-right ${D(m.qty).lt(0) ? "text-bad" : "text-good"}`}>{D(m.qty).gt(0) ? "+" : ""}{D(m.qty).toString()}</td>
          <td className="num text-right">{formatINR(m.value)}</td><td className="text-ink-2">{m.note}</td></tr>)}</tbody>
      </table>}
    </Card>
  </>;
}
