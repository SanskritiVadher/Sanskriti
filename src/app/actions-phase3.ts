"use server";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { UserFacingError } from "@/lib/errors";
import { createParty, updateParty, setPartyOpening, recordCustomerPayment, recordSupplierPayment, type PartyInput } from "@/lib/services/parties";
import { createProduct, updateProduct, adjustStock, type AdjustReason, type ProductInput } from "@/lib/services/inventory";
import { createPreview, confirmImport, type ImportKind } from "@/lib/services/importer";
import { moveCategory, unpaidBill, ownerMoney, depreciation } from "@/lib/services/corrections";
import { addBrand } from "@/lib/services/company";
import { cashPaymentWarnings, cashReceiptWarnings } from "@/lib/services/sales";
import { schema } from "@/db";
import { and, eq } from "drizzle-orm";

const s = (f: FormData, k: string) => String(f.get(k) ?? "");
function fail(path: string, e: unknown, keep: Record<string, string> = {}): never {
  const msg = e instanceof UserFacingError ? e.message : "Something went wrong. Nothing was saved. Please try again.";
  if (!(e instanceof UserFacingError)) console.error(e);
  const q = new URLSearchParams({ ...keep, error: msg, ...(e instanceof UserFacingError && e.field ? { field: e.field } : {}) });
  redirect(`${path}${path.includes("?") ? "&" : "?"}${q}`);
}
const partyFields = (f: FormData): PartyInput => ({
  name: s(f, "name"), contactPerson: s(f, "contactPerson"), phone: s(f, "phone"), whatsapp: s(f, "whatsapp"), email: s(f, "email"),
  gstin: s(f, "gstin"), stateCode: s(f, "stateCode"), addressLine1: s(f, "addressLine1"), city: s(f, "city"), pincode: s(f, "pincode"),
  creditLimit: s(f, "creditLimit"), creditDays: s(f, "creditDays"), priceLevel: (s(f, "priceLevel") || "DEALER") as PartyInput["priceLevel"], notes: s(f, "notes"),
});
const keepForm = (f: FormData) => Object.fromEntries([...f.entries()].filter(([k, v]) => typeof v === "string" && !k.startsWith("$")).map(([k, v]) => [k, String(v)]));
const base = (t: string) => (t === "SUPPLIER" ? "/suppliers" : "/customers");

export async function savePartyAction(f: FormData) {
  const type = s(f, "type") === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER";
  const ctx = await requireContext(type === "CUSTOMER" ? "sales.create" : "purchases.create");
  const id = s(f, "id");
  let p;
  try {
    p = id ? await updateParty(db, ctx.company.id, ctx.user.id, id, partyFields(f))
      : await createParty(db, ctx.company.id, ctx.user.id, type, { ...partyFields(f), openingBalance: s(f, "openingBalance"), openingDate: s(f, "openingDate") });
  } catch (e) { fail(id ? `${base(type)}/${id}/edit` : `${base(type)}/new`, e, keepForm(f)); }
  redirect(`${base(type)}/${p!.id}?saved=1`);
}

export async function partyOpeningAction(f: FormData) {
  const ctx = await requireContext("ledger.post_manual");
  const id = s(f, "id"), type = s(f, "type");
  try { await setPartyOpening(db, ctx.company.id, ctx.user.id, id, s(f, "openingBalance"), s(f, "openingDate")); }
  catch (e) { fail(`${base(type)}/${id}/edit`, e); }
  redirect(`${base(type)}/${id}?saved=1`);
}

export async function partyPaymentAction(f: FormData) {
  const ctx = await requireContext("money.record");
  const id = s(f, "id"), type = s(f, "type");
  const args = { companyId: ctx.company.id, userId: ctx.user.id, partyId: id, cashBankId: s(f, "cashBankId"), amount: s(f, "amount"), date: s(f, "date"), narration: s(f, "narration") };
  let warnings: string[] = [];
  try {
    if (type === "SUPPLIER") await recordSupplierPayment(db, args); else await recordCustomerPayment(db, args);
    const cash = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, args.cashBankId), eq(schema.accounts.systemKey, "CASH")) });
    if (cash) warnings = type === "SUPPLIER" ? await cashPaymentWarnings(db, ctx.company.id, args.date, args.amount, id) : await cashReceiptWarnings(db, ctx.company.id, id, args.date);
  } catch (e) { fail(`${base(type)}/${id}`, e, { amount: s(f, "amount") }); }
  redirect(`${base(type)}/${id}?paid=1${warnings.length ? `&w=${encodeURIComponent(JSON.stringify(warnings))}` : ""}`);
}

const productFields = (f: FormData): ProductInput => ({
  name: s(f, "name"), sku: s(f, "sku"), brandId: s(f, "brandId"), categoryName: s(f, "categoryName"), hsn: s(f, "hsn"),
  gstRate: s(f, "gstRate"), gstConfirmed: s(f, "gstConfirmed") === "1", unit: s(f, "unit"), purchasePrice: s(f, "purchasePrice"),
  dealerPrice: s(f, "dealerPrice"), wholesalePrice: s(f, "wholesalePrice"), retailPrice: s(f, "retailPrice"), mrp: s(f, "mrp"),
  minSellingPrice: s(f, "minSellingPrice"), reorderLevel: s(f, "reorderLevel"), trackSerial: s(f, "trackSerial") === "1", warrantyMonths: s(f, "warrantyMonths"),
});

export async function saveProductAction(f: FormData) {
  const ctx = await requireContext("inventory.adjust");
  const id = s(f, "id");
  let p;
  try {
    p = id ? await updateProduct(db, ctx.company.id, ctx.user.id, id, { ...productFields(f), isActive: s(f, "isActive") !== "0" })
      : await createProduct(db, ctx.company.id, ctx.user.id, { ...productFields(f), openingQty: s(f, "openingQty"), openingRate: s(f, "openingRate"), openingDate: s(f, "openingDate") });
  } catch (e) { fail(id ? `/inventory/${id}/edit` : "/inventory/new", e, keepForm(f)); }
  redirect(`/inventory/${p!.id}?saved=1`);
}

export async function adjustStockAction(f: FormData) {
  const ctx = await requireContext("inventory.adjust");
  const id = s(f, "productId");
  try {
    await adjustStock(db, { companyId: ctx.company.id, userId: ctx.user.id, productId: id, reason: s(f, "reason") as AdjustReason,
      qty: s(f, "qty"), date: s(f, "date"), note: s(f, "note"), unitCost: s(f, "unitCost") });
  } catch (e) { fail(`/inventory/${id}`, e); }
  redirect(`/inventory/${id}?adjusted=1`);
}

export async function quickBrandAction(f: FormData) {
  const ctx = await requireContext("inventory.adjust");
  try { await addBrand(db, ctx.company.id, ctx.user.id, s(f, "brand")); } catch (e) { fail("/inventory/new", e); }
  redirect("/inventory/new");
}

export async function uploadImportAction(f: FormData) {
  const kind = s(f, "kind") as ImportKind;
  const ctx = await requireContext(kind === "products" ? "inventory.adjust" : kind === "customers" ? "sales.create" : "purchases.create");
  const file = f.get("file");
  let b;
  try {
    if (!(file instanceof File) || file.size === 0) throw new UserFacingError("Please choose a file.");
    b = await createPreview(db, ctx.company.id, ctx.user.id, kind, file.name, Buffer.from(await file.arrayBuffer()));
  } catch (e) { fail(`/import?kind=${kind}`, e); }
  redirect(`/import/${b!.id}`);
}

export async function confirmImportAction(f: FormData) {
  const ctx = await requireContext();
  const id = s(f, "batchId");
  const batch = await db.query.importBatches.findFirst({ where: and(eq(schema.importBatches.id, id), eq(schema.importBatches.companyId, ctx.company.id)) });
  const need = batch?.kind === "products" ? "inventory.adjust" : batch?.kind === "customers" ? "sales.create" : "purchases.create";
  await requireContext(need);
  let n = 0;
  try { n = await confirmImport(db, ctx.company.id, ctx.user.id, id, s(f, "openingDate")); } catch (e) { fail(`/import/${id}`, e); }
  const dest = batch!.kind === "products" ? "/inventory" : `/${batch!.kind}`;
  redirect(`${dest}?imported=${n}`);
}

export async function discardImportAction(f: FormData) {
  const ctx = await requireContext();
  await db.update(schema.importBatches).set({ status: "DISCARDED" })
    .where(and(eq(schema.importBatches.id, s(f, "batchId")), eq(schema.importBatches.companyId, ctx.company.id), eq(schema.importBatches.status, "PREVIEW")));
  redirect(`/import?kind=${s(f, "kind")}`);
}

export async function correctionAction(f: FormData) {
  const ctx = await requireContext("money.record");
  const kind = s(f, "kind");
  const b = { companyId: ctx.company.id, userId: ctx.user.id, date: s(f, "date"), amount: s(f, "amount"), note: s(f, "note") };
  let e;
  try {
    if (kind === "category") e = await moveCategory(db, { ...b, fromId: s(f, "fromId"), toId: s(f, "toId") });
    else if (kind === "unpaid") e = await unpaidBill(db, { ...b, expenseId: s(f, "expenseId") });
    else if (kind === "drawings") e = await ownerMoney(db, { ...b, cashBankId: s(f, "cashBankId"), direction: "OUT" });
    else if (kind === "capital") e = await ownerMoney(db, { ...b, cashBankId: s(f, "cashBankId"), direction: "IN" });
    else if (kind === "depreciation") e = await depreciation(db, { ...b, assetId: s(f, "assetId"), ratePct: s(f, "ratePct"), halfYear: s(f, "halfYear") === "1" });
    else throw new UserFacingError("Choose what happened.");
  } catch (err) { fail(`/money/fix?kind=${kind}`, err, { amount: s(f, "amount"), note: s(f, "note") }); }
  redirect(`/reports/entry/${e!.id}?saved=1`);
}
