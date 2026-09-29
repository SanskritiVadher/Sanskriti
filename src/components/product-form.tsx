import Link from "next/link";
import { db } from "@/db";
import { listBrands, listCategories } from "@/lib/services/inventory";
import { todayIST, fyStart } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, Select } from "@/components/ui";
import { saveProductAction } from "@/app/actions-phase3";

type P = Partial<Record<string, string | number | boolean | null>> & { id: string };
export async function ProductForm({ companyId, product, sp, categoryName }: { companyId: string; product?: P; sp: Record<string, string | undefined>; categoryName?: string | null }) {
  const [brands, cats] = await Promise.all([listBrands(db, companyId), listCategories(db, companyId)]);
  const v = (k: string) => (sp[k] ?? (product?.[k] != null ? String(product[k]) : "")) as string;
  const err = (f: string) => (sp.field === f ? sp.error : undefined);
  return <Card>
    {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <form action={saveProductAction} className="grid gap-4 sm:grid-cols-3">
      {product && <input type="hidden" name="id" value={product.id} />}
      <div className="sm:col-span-2"><Field label="Product name" hint="e.g. SF Sonic FS1080-DIN 35Ah" error={err("name")}><Input name="name" defaultValue={v("name")} required autoFocus={!product} /></Field></div>
      <Field label="Code / SKU" hint="Leave empty to create one" error={err("sku")}><Input name="sku" defaultValue={v("sku")} className="uppercase" /></Field>
      <Field label="Brand" error={err("brandId")}><Select name="brandId" defaultValue={v("brandId")}><option value="">—</option>{brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
      <Field label="Category" hint="e.g. Batteries, Fans"><Input name="categoryName" defaultValue={sp.categoryName ?? categoryName ?? ""} list="cats" /></Field>
      <datalist id="cats">{cats.map((c) => <option key={c.id} value={c.name} />)}</datalist>
      <Field label="Unit"><Input name="unit" defaultValue={v("unit") || "pcs"} /></Field>

      <fieldset className="grid gap-4 sm:col-span-3 sm:grid-cols-3">
        <legend className="mb-2 text-[15px] font-semibold">Prices (₹, before GST)</legend>
        <Field label="Purchase price" error={err("purchasePrice")}><Input name="purchasePrice" defaultValue={v("purchasePrice")} inputMode="decimal" /></Field>
        <Field label="Dealer price" error={err("dealerPrice")}><Input name="dealerPrice" defaultValue={v("dealerPrice")} inputMode="decimal" /></Field>
        <Field label="Wholesale price" error={err("wholesalePrice")}><Input name="wholesalePrice" defaultValue={v("wholesalePrice")} inputMode="decimal" /></Field>
        <Field label="Retail price" error={err("retailPrice")}><Input name="retailPrice" defaultValue={v("retailPrice")} inputMode="decimal" /></Field>
        <Field label="MRP" error={err("mrp")}><Input name="mrp" defaultValue={v("mrp")} inputMode="decimal" /></Field>
        <Field label="Lowest price allowed" hint="Warn if sold below this" error={err("minSellingPrice")}><Input name="minSellingPrice" defaultValue={v("minSellingPrice")} inputMode="decimal" /></Field>
      </fieldset>

      <fieldset className="grid gap-4 sm:col-span-3 sm:grid-cols-3">
        <legend className="mb-2 text-[15px] font-semibold">GST</legend>
        <Field label="HSN code" hint="4, 6 or 8 digits" error={err("hsn")}><Input name="hsn" defaultValue={v("hsn")} inputMode="numeric" /></Field>
        <Field label="GST rate (%)" error={err("gstRate")}><Input name="gstRate" defaultValue={v("gstRate")} inputMode="decimal" /></Field>
        <label className="flex items-start gap-2 pt-7 text-[14px]"><input type="checkbox" name="gstConfirmed" value="1" defaultChecked={product?.gstRateStatus === "USER_CONFIRMED"} className="mt-1" />
          I have checked this rate with my CA / Tally</label>
        <p className="text-[13px] text-ink-3 sm:col-span-3">The app does not guess GST rates. An unticked rate is shown as &ldquo;not confirmed&rdquo; until checked. Automatic checks against official sources come in Phase 5.</p>
      </fieldset>

      <fieldset className="grid gap-4 sm:col-span-3 sm:grid-cols-3">
        <legend className="mb-2 text-[15px] font-semibold">Stock</legend>
        <Field label="Reorder when stock falls to" hint="You'll be warned at this level" error={err("reorderLevel")}><Input name="reorderLevel" defaultValue={v("reorderLevel")} inputMode="decimal" /></Field>
        <Field label="Warranty (months)" error={err("warrantyMonths")}><Input name="warrantyMonths" defaultValue={v("warrantyMonths")} inputMode="numeric" /></Field>
        <label className="flex items-start gap-2 pt-7 text-[14px]"><input type="checkbox" name="trackSerial" value="1" defaultChecked={!!product?.trackSerial} className="mt-1" />
          Has serial numbers (tracked from billing, Phase 4)</label>
      </fieldset>

      {!product && <fieldset className="grid gap-4 sm:col-span-3 sm:grid-cols-3">
        <legend className="mb-2 text-[15px] font-semibold">Stock you have now (optional)</legend>
        <Field label="Quantity" error={err("openingQty")}><Input name="openingQty" defaultValue={sp.openingQty} inputMode="decimal" /></Field>
        <Field label="Cost per unit (₹)" hint="Leave empty to use purchase price" error={err("openingRate")}><Input name="openingRate" defaultValue={sp.openingRate} inputMode="decimal" /></Field>
        <Field label="As on"><Input type="date" name="openingDate" defaultValue={sp.openingDate || fyStart(todayIST())} /></Field>
      </fieldset>}
      {product && <label className="flex items-center gap-2 text-[14px] sm:col-span-3"><input type="checkbox" name="isActive" value="0" defaultChecked={product.isActive === false} /> Stopped selling this (hide from billing)</label>}
      <div className="flex gap-3 sm:col-span-3"><Button>Save product</Button><Link href={product ? `/inventory/${product.id}` : "/inventory"} className="py-2.5 text-ink-2">Cancel</Link></div>
    </form>
  </Card>;
}
