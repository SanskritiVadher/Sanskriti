"use client";
/**
 * Fast billing form (sales or purchase). Live totals use the SAME calculation module as the server,
 * so what you see is exactly what gets saved. The server re-checks everything.
 */
import { useActionState, useMemo, useState, useRef } from "react";
import Decimal from "decimal.js";
import { calcInvoice, supplyType, type Registration } from "@/lib/gst/calc";
import type { DocState } from "@/app/actions-phase4";

export type PartyOpt = { id: string; name: string; state: string | null; gstin: string | null; priceLevel: string; creditLimit: string | null;
  creditDays: number | null; balance: string; overdue: string; oldestOverdueDays: number };
export type ProductOpt = { id: string; name: string; sku: string; unit: string; gstRate: string | null; gstConfirmed: boolean; stock: string; avgCost: string;
  dealer: string | null; wholesale: string | null; retail: string | null; purchase: string | null; minPrice: string | null; hsn: string | null };
type Line = { key: number; productId: string; qty: string; rate: string; disc: string; gst: string; serials: string };

const fmt = (v: Decimal.Value) => {
  const d = new Decimal(v).toDecimalPlaces(2); const neg = d.isNegative();
  const [i, f] = d.abs().toFixed(2).split("."); const l3 = i.slice(-3), rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${neg ? "−" : ""}₹${rest ? rest + "," + l3 : l3}.${f}`;
};
const safe = (v: string) => { try { const d = new Decimal((v || "0").replace(/,/g, "")); return d.isFinite() ? d : new Decimal(0); } catch { return new Decimal(0); } };

export function BillForm({ mode, action, parties, products, cashBank, company, today, lastRates }: {
  mode: "sale" | "purchase"; action: (s: DocState, f: FormData) => Promise<DocState>;
  parties: PartyOpt[]; products: ProductOpt[]; cashBank: { id: string; label: string }[];
  company: { state: string | null; registration: Registration }; today: string; lastRates?: Record<string, Record<string, string>>;
}) {
  const sale = mode === "sale";
  const [state, formAction, pending] = useActionState(action, undefined);
  const [partyQ, setPartyQ] = useState("");
  const [partyId, setPartyId] = useState("");
  const [lines, setLines] = useState<Line[]>([{ key: 1, productId: "", qty: "1", rate: "", disc: "", gst: "", serials: "" }]);
  const [paid, setPaid] = useState("");
  const [override, setOverride] = useState("");
  const nextKey = useRef(2);
  const party = parties.find((p) => p.id === partyId);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const byLabel = useMemo(() => new Map(products.map((p) => [`${p.name} · ${p.sku}`, p])), [products]);

  const type = sale ? supplyType(company.registration, company.state, party?.state ?? company.state)
    : !party?.gstin ? "NONE" : (party.state ?? company.state) === company.state ? "INTRA" : "INTER";
  const valid = lines.filter((l) => l.productId && safe(l.qty).gt(0));
  const calc = calcInvoice(valid.map((l) => ({ qty: safe(l.qty), rate: safe(l.rate), discountPct: safe(l.disc), gstRate: l.gst || byId.get(l.productId)?.gstRate || 0 })), type);

  const priceFor = (p: ProductOpt) => {
    if (!sale) return p.purchase ?? "";
    const last = party && lastRates?.[party.id]?.[p.id];
    if (last) return last;
    return (party?.priceLevel === "RETAIL" ? p.retail : party?.priceLevel === "WHOLESALE" ? p.wholesale : p.dealer) ?? p.dealer ?? "";
  };
  const set = (key: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pickProduct = (key: number, label: string) => {
    const p = byLabel.get(label);
    if (!p) return;
    set(key, { productId: p.id, rate: priceFor(p), gst: sale ? "" : p.gstRate ?? "" });
    const isLast = lines[lines.length - 1]?.key === key;
    if (isLast) setLines((ls) => [...ls, { key: nextKey.current++, productId: "", qty: "1", rate: "", disc: "", gst: "", serials: "" }]);
  };

  // Live warnings (the server repeats these checks).
  const warn: string[] = [];
  const needs = new Map<string, Decimal>();
  valid.forEach((l) => needs.set(l.productId, (needs.get(l.productId) ?? new Decimal(0)).plus(safe(l.qty))));
  if (sale) {
    needs.forEach((q, id) => { const p = byId.get(id)!; if (q.gt(p.stock)) warn.push(`Only ${new Decimal(p.stock).toString()} ${p.unit} of ${p.name} in stock.`); });
    valid.forEach((l, i) => {
      const p = byId.get(l.productId)!, net = calc.lines[i].taxable.div(safe(l.qty));
      if (p.minPrice && net.lt(p.minPrice)) warn.push(`${p.name}: below your lowest allowed price (${fmt(p.minPrice)}).`);
      else if (new Decimal(p.avgCost).gt(0) && net.lt(p.avgCost)) warn.push(`${p.name}: selling below cost (${fmt(p.avgCost)}).`);
      if (type !== "NONE" && !p.gstRate) warn.push(`${p.name} has no GST rate. Set it on the product page first.`);
      else if (type !== "NONE" && !p.gstConfirmed) warn.push(`${p.name}: GST rate ${p.gstRate}% not confirmed.`);
    });
    if (party) {
      const projected = new Decimal(party.balance).plus(calc.total).minus(safe(paid));
      if (party.creditLimit && projected.gt(party.creditLimit)) warn.push(`Over credit limit: ${party.name} would owe ${fmt(projected)} (limit ${fmt(party.creditLimit)}).`);
      if (new Decimal(party.overdue).gt(0)) warn.push(`${party.name} already has ${fmt(party.overdue)} overdue (oldest ${party.oldestOverdueDays} days).`);
    }
    if (type === "INTER" && calc.total.gt(50000)) warn.push("Inter-state bill over ₹50,000: an e-way bill will be needed.");
  }
  const margin = sale && calc.taxable.gt(0) ? calc.taxable.minus(valid.reduce((s, l) => s.plus(safe(l.qty).mul(byId.get(l.productId)!.avgCost)), new Decimal(0))) : null;

  const matches = partyQ.length ? parties.filter((p) => p.name.toLowerCase().includes(partyQ.toLowerCase())).slice(0, 8) : [];
  const payload = JSON.stringify(valid.map((l) => sale ? { productId: l.productId, qty: l.qty, rate: l.rate, discountPct: l.disc, serials: l.serials } : { productId: l.productId, qty: l.qty, rate: l.rate, gstRate: l.gst }));
  const input = "w-full rounded-lg border border-line bg-surface px-3 py-2 text-[15px] focus:border-brand focus:outline-none";

  return <form action={formAction} className="space-y-5">
    <input type="hidden" name="lines" value={payload} /><input type="hidden" name="partyId" value={partyId} />
    {state?.error && <div role="alert" className="rounded-xl bg-bad-bg px-4 py-3 text-bad">⚠ {state.error}</div>}

    <section className="grid gap-4 rounded-2xl border border-line bg-surface p-5 md:grid-cols-3">
      <div className="relative md:col-span-2">
        <label className="mb-1.5 block text-[14px] font-medium">{sale ? "Customer" : "Supplier"}</label>
        {party ? <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2">
          <div><p className="font-medium">{party.name}</p>
            <p className="text-[13px] text-ink-2">{[party.gstin ?? "Unregistered", sale && `owes ${fmt(party.balance)}`, sale && new Decimal(party.overdue).gt(0) && `${fmt(party.overdue)} overdue`, party.creditLimit && `limit ${fmt(party.creditLimit)}`].filter(Boolean).join(" · ")}</p></div>
          <button type="button" onClick={() => { setPartyId(""); setPartyQ(""); }} className="text-[14px] text-brand underline">Change</button></div>
        : <><input autoFocus className={input} placeholder={`Type ${sale ? "customer" : "supplier"} name…`} value={partyQ} onChange={(e) => setPartyQ(e.target.value)} aria-label="Search party" />
          {matches.length > 0 && <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-line bg-surface shadow-lg">{matches.map((p) =>
            <li key={p.id}><button type="button" className="w-full px-3 py-2 text-left hover:bg-surface-2" onClick={() => { setPartyId(p.id); setLines((ls) => ls.map((l) => { const pr = byId.get(l.productId); return pr ? { ...l, rate: l.rate || priceFor(pr) } : l; })); }}>
              {p.name} <span className="text-[13px] text-ink-3">{p.gstin ?? ""}</span></button></li>)}</ul>}
          {partyQ && !matches.length && <p className="mt-1 text-[13px] text-ink-3">No match. <a className="text-brand underline" href={sale ? "/customers/new" : "/suppliers/new"}>Add new</a></p>}</>}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-1">
        <label className="block text-[14px] font-medium">Date<input type="date" name="date" defaultValue={today} className={`${input} mt-1.5`} required /></label>
        {!sale && <label className="block text-[14px] font-medium">Supplier&rsquo;s bill no.<input name="billNumber" className={`${input} mt-1.5`} required placeholder="As printed on their bill" /></label>}
      </div>
      {party && <p className="text-[13px] text-ink-2 md:col-span-3">
        {type === "NONE" ? (sale ? "No GST on this bill (you're not a regular GST registrant)." : "Supplier is unregistered: no GST on this bill.")
          : type === "INTRA" ? "Same state: CGST + SGST." : "Other state: IGST."}
        {sale && party.creditDays != null && ` Payment due in ${party.creditDays} days.`}</p>}
    </section>

    <section className="overflow-x-auto rounded-2xl border border-line bg-surface p-5">
      <datalist id="products">{products.map((p) => <option key={p.id} value={`${p.name} · ${p.sku}`}>{sale ? `${new Decimal(p.stock).toString()} ${p.unit} in stock` : ""}</option>)}</datalist>
      <table className="w-full min-w-[720px] text-[15px]">
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Product</th><th className="w-24 pb-2">Qty</th><th className="w-32 pb-2">{sale ? "Rate (before GST)" : "Rate (before GST)"}</th>
          {sale ? <th className="w-20 pb-2">Disc %</th> : <th className="w-20 pb-2">GST %</th>}<th className="w-32 pb-2 text-right">Amount</th><th className="w-8" /></tr></thead>
        <tbody>{lines.map((l) => {
          const p = byId.get(l.productId); const i = valid.findIndex((v) => v.key === l.key);
          return <tr key={l.key} className="align-top">
            <td className="py-1 pr-2"><input list="products" className={input} placeholder="Type to search…" defaultValue={p ? `${p.name} · ${p.sku}` : ""}
              onChange={(e) => pickProduct(l.key, e.target.value)} aria-label="Product" />
              {p && <p className="mt-1 text-[12px] text-ink-3">{[p.hsn && `HSN ${p.hsn}`, sale && `${new Decimal(p.stock).toString()} in stock`, p.gstRate && `GST ${p.gstRate}%`].filter(Boolean).join(" · ")}</p>}
              {sale && p && <input className={`${input} mt-1 !py-1 text-[13px]`} placeholder="Serial numbers (optional)" value={l.serials} onChange={(e) => set(l.key, { serials: e.target.value })} aria-label="Serial numbers" />}</td>
            <td className="py-1 pr-2"><input className={`${input} num`} inputMode="decimal" value={l.qty} onChange={(e) => set(l.key, { qty: e.target.value })} aria-label="Quantity" /></td>
            <td className="py-1 pr-2"><input className={`${input} num`} inputMode="decimal" value={l.rate} onChange={(e) => set(l.key, { rate: e.target.value })} aria-label="Rate" /></td>
            {sale ? <td className="py-1 pr-2"><input className={`${input} num`} inputMode="decimal" value={l.disc} onChange={(e) => set(l.key, { disc: e.target.value })} aria-label="Discount percent" /></td>
              : <td className="py-1 pr-2"><input className={`${input} num`} inputMode="decimal" value={l.gst} onChange={(e) => set(l.key, { gst: e.target.value })} aria-label="GST percent" disabled={type === "NONE"} /></td>}
            <td className="num py-3 text-right">{i >= 0 ? fmt(calc.lines[i].taxable) : ""}</td>
            <td className="py-2 text-right">{lines.length > 1 && <button type="button" aria-label="Remove line" className="text-ink-3 hover:text-bad" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>✕</button>}</td>
          </tr>; })}</tbody>
      </table>
      <button type="button" className="mt-2 text-[14px] text-brand underline" onClick={() => setLines((ls) => [...ls, { key: nextKey.current++, productId: "", qty: "1", rate: "", disc: "", gst: "", serials: "" }])}>+ Add line</button>
    </section>

    <section className="grid gap-4 md:grid-cols-2">
      <div className="space-y-3 rounded-2xl border border-line bg-surface p-5">
        {warn.length > 0 ? <ul className="space-y-1.5">{warn.map((w) => <li key={w} className="rounded-lg bg-warn-bg px-3 py-2 text-[14px] text-warn">⚠ {w}</li>)}</ul>
          : valid.length > 0 && <p className="rounded-lg bg-good-bg px-3 py-2 text-[14px] text-good">✓ No problems found.</p>}
        {margin && <p className="text-[14px] text-ink-2">Profit on this bill (before expenses): <b className={margin.lt(0) ? "text-bad" : "text-ink"}>{fmt(margin)}</b>
          {calc.taxable.gt(0) && ` · ${margin.div(calc.taxable).mul(100).toFixed(1)}% margin`}</p>}
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-[14px] font-medium">{sale ? "Paid now (₹)" : "Paid now (₹)"}<input name="paidAmount" value={paid} onChange={(e) => setPaid(e.target.value)} inputMode="decimal" className={`${input} mt-1.5 num`} placeholder={sale ? "0 = on credit" : "0 = on credit"} /></label>
          <label className="block text-[14px] font-medium">{sale ? "Received into" : "Paid from"}<select name="cashBankId" className={`${input} mt-1.5`}>{cashBank.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
        </div>
        <label className="block text-[14px] font-medium">Note on bill (optional)<input name="notes" className={`${input} mt-1.5`} /></label>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-5">
        <dl className="space-y-1.5 text-[15px]">
          {calc.discount.gt(0) && <div className="flex justify-between text-ink-2"><dt>Discount</dt><dd className="num">−{fmt(calc.discount)}</dd></div>}
          <div className="flex justify-between"><dt>Product value</dt><dd className="num">{fmt(calc.taxable)}</dd></div>
          {type === "INTRA" && <><div className="flex justify-between text-ink-2"><dt>CGST</dt><dd className="num">{fmt(calc.cgst)}</dd></div>
            <div className="flex justify-between text-ink-2"><dt>SGST</dt><dd className="num">{fmt(calc.sgst)}</dd></div></>}
          {type === "INTER" && <div className="flex justify-between text-ink-2"><dt>IGST</dt><dd className="num">{fmt(calc.igst)}</dd></div>}
          {!calc.roundOff.isZero() && <div className="flex justify-between text-ink-3"><dt>Round off</dt><dd className="num">{fmt(calc.roundOff)}</dd></div>}
          <div className="flex justify-between border-t border-line pt-2 text-[22px] font-semibold"><dt>{sale ? "Bill total" : "Bill total"}</dt><dd className="num">{fmt(calc.total)}</dd></div>
          {safe(paid).gt(0) && <div className="flex justify-between text-ink-2"><dt>{sale ? "Still to collect" : "Still to pay"}</dt><dd className="num">{fmt(calc.total.minus(safe(paid)))}</dd></div>}
        </dl>
        {state?.credit && <div className="mt-4 rounded-xl bg-warn-bg p-4 text-warn">
          <p className="font-semibold">⚠ {state.credit.message}</p>
          {new Decimal(state.credit.overdue).gt(0) && <p className="mt-1 text-[14px]">They also have {fmt(state.credit.overdue)} overdue.</p>}
          <label className="mt-3 block text-[14px] font-medium text-ink">To go ahead anyway, write why (saved with the bill):
            <input name="overrideReason" value={override} onChange={(e) => setOverride(e.target.value)} className={`${input} mt-1.5`} placeholder="e.g. Old customer, promised payment Friday" /></label>
        </div>}
        <button disabled={pending || !partyId || !valid.length} className="mt-5 w-full rounded-lg bg-brand px-4 py-3 text-[16px] font-semibold text-brand-ink disabled:opacity-40">
          {pending ? "Saving…" : sale ? "Save bill" : "Save purchase"}</button>
        {!partyId && <p className="mt-2 text-center text-[13px] text-ink-3">Choose a {sale ? "customer" : "supplier"} to continue.</p>}
      </div>
    </section>
  </form>;
}
