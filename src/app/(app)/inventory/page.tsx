import Link from "next/link";
import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { db } from "@/db";
import { stockList, listBrands } from "@/lib/services/inventory";
import { formatINR, formatINRShort, D } from "@/lib/money";
import { getViewMode } from "@/lib/view-mode";
import { Card, Input, LinkButton, Notice, PageHeader, Select, Status } from "@/components/ui";

export default async function Inventory({ searchParams }: { searchParams: Promise<{ q?: string; brand?: string; imported?: string; show?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const accountant = (await getViewMode()) === "accountant";
  const [all, brands] = await Promise.all([stockList(db, ctx.company.id, { q: sp.q, brandId: sp.brand }), listBrands(db, ctx.company.id)]);
  const active = all.filter((r) => r.isActive);
  const value = active.reduce((s, r) => s.plus(r.value), D(0));
  const low = active.filter((r) => r.status === "LOW"), out = active.filter((r) => r.status === "OUT"), neg = active.filter((r) => r.status === "NEGATIVE");
  const unconfirmedGst = active.filter((r) => r.gstRateStatus !== "USER_CONFIRMED").length;
  const byBrand = brands.map((b) => ({ name: b.name, value: active.filter((r) => r.brand === b.name).reduce((s, r) => s.plus(r.value), D(0)) })).filter((b) => b.value.gt(0));
  const shown = sp.show === "low" ? [...neg, ...out, ...low] : all;
  const edit = can(ctx.role, "inventory.adjust");

  return <>
    <PageHeader title="Inventory" subtitle="What stock do I have?" action={<div className="flex gap-2"><LinkButton href="/inventory/insights" variant="secondary">Stock insights</LinkButton>{edit && <>
      <LinkButton href="/inventory/new">+ Add product</LinkButton><LinkButton href="/import?kind=products" variant="secondary">Import from Excel / Tally</LinkButton></>}</div>} />
    {sp.imported && <div className="mb-4"><Notice tone="good" title={`${sp.imported} products imported.`} /></div>}

    {all.length > 0 && <div className="mb-6 grid gap-4 md:grid-cols-3">
      <Card><p className="text-[14px] text-ink-2">Stock value</p><p className="num mt-1 text-[30px] font-semibold">{formatINRShort(value)}</p>
        <p className="mt-1 text-[14px] text-ink-2">Money sitting in stock, at what you paid for it.</p>
        {byBrand.length > 1 && <p className="mt-2 text-[14px] text-ink-2">{byBrand.map((b) => `${b.name} ${value.isZero() ? 0 : b.value.div(value).mul(100).toFixed(0)}%`).join(" · ")}</p>}</Card>
      <Card><p className="text-[14px] text-ink-2">Needs attention</p>
        <ul className="mt-2 space-y-1.5 text-[15px]">
          <li>{out.length ? <Status tone="bad">{out.length} out of stock</Status> : <Status tone="good">Nothing out of stock</Status>}</li>
          <li>{low.length ? <Status tone="warn">{low.length} running low</Status> : <Status tone="good">Nothing running low</Status>}</li>
          {neg.length > 0 && <li><Status tone="bad">{neg.length} below zero. Check these.</Status></li>}
        </ul>
        {(low.length + out.length + neg.length) > 0 && <Link href="/inventory?show=low" className="mt-2 inline-block text-[14px] text-brand underline">Show only these</Link>}</Card>
      <Card><p className="text-[14px] text-ink-2">Not known yet</p>
        <p className="mt-2 text-[14px] text-ink-2">Slow-moving stock, days until stock runs out, and what to reorder need sales history. They appear once billing is live (Phase 4).</p>
        {unconfirmedGst > 0 && <p className="mt-2 text-[14px]"><Status tone="warn">{unconfirmedGst} products: GST rate not confirmed</Status></p>}</Card>
    </div>}

    <form className="mb-4 flex flex-wrap gap-2">
      <div className="min-w-60 flex-1"><Input name="q" defaultValue={sp.q} placeholder="Search name or code" aria-label="Search products" /></div>
      <Select name="brand" defaultValue={sp.brand ?? ""} aria-label="Brand" className="!w-auto"><option value="">All brands</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>
      <button className="rounded-lg border border-line bg-surface px-4">Filter</button>
    </form>
    <Card className="overflow-x-auto">
      {shown.length === 0 ? <div className="py-6 text-center text-ink-2">{all.length ? "No match." : <>No products yet.{edit && <> <Link className="text-brand underline" href="/import?kind=products">Import from Tally / Excel</Link> or add one.</>}</>}</div> :
      <table className="w-full text-[15px]">
        <caption className="sr-only">Products</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Product</th><th className="hidden pb-2 sm:table-cell">Brand</th><th className="pb-2 text-right">In stock</th>
          <th className="hidden pb-2 text-right sm:table-cell">{accountant ? "Avg cost" : "Cost each"}</th><th className="pb-2 text-right">Value</th><th className="pb-2">Status</th></tr></thead>
        <tbody>{shown.map((r) => <tr key={r.id} className={`border-t border-line ${!r.isActive ? "opacity-50" : ""}`}>
          <td className="py-2.5"><Link href={`/inventory/${r.id}`} className="font-medium hover:underline">{r.name}</Link><span className="block text-[12px] text-ink-3">{r.sku}</span></td>
          <td className="hidden text-ink-2 sm:table-cell">{r.brand}</td>
          <td className="num text-right">{r.qty.toString()} {r.unit}</td>
          <td className="num hidden text-right sm:table-cell">{r.qty.gt(0) ? formatINR(r.avgCost) : "—"}</td>
          <td className="num text-right">{formatINR(r.value)}</td>
          <td>{r.status === "OUT" ? <Status tone="bad">Out</Status> : r.status === "LOW" ? <Status tone="warn">Low</Status> : r.status === "NEGATIVE" ? <Status tone="bad">Below zero</Status> : <Status tone="good">OK</Status>}</td>
        </tr>)}</tbody>
      </table>}
    </Card>
  </>;
}
