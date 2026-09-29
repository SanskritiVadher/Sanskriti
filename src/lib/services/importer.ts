/**
 * Excel / CSV import for customers, suppliers and products.
 * Flow: upload → parse → validate every row → owner sees a preview (OK / will skip / error) → confirm.
 * Nothing is saved until the owner confirms, and the whole confirmed import is one transaction.
 * Header matching is forgiving so Tally exports ("Ledger Name", "GSTIN/UIN", "Opening Balance … Dr") work.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { and, eq, sql } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { D } from "@/lib/money";
import { GST_STATES } from "@/lib/gst/states";
import { UserFacingError } from "@/lib/errors";
import { validatePartyInput, createParty, type PartyInput } from "./parties";
import { validateProduct, createProduct } from "./inventory";
import { addBrand } from "./company";
import { audit } from "./audit";

export type ImportKind = "customers" | "suppliers" | "products";

const ALIASES: Record<ImportKind, Record<string, string[]>> = {
  customers: {
    name: ["name", "party name", "ledger name", "customer name", "customer", "particulars", "ledger"],
    contactPerson: ["contact person", "contact name"],
    phone: ["phone", "mobile", "mobile no", "mobile number", "phone no", "phone number", "contact no", "contact number"],
    whatsapp: ["whatsapp", "whatsapp no", "whatsapp number"],
    email: ["email", "e-mail", "email id"],
    gstin: ["gstin", "gstin/uin", "gst no", "gst number", "gstin no", "gstin/uin no"],
    state: ["state", "state name"],
    addressLine1: ["address", "address 1", "address line 1", "mailing address"],
    city: ["city", "town"],
    pincode: ["pincode", "pin", "pin code", "postal code"],
    creditLimit: ["credit limit"],
    creditDays: ["credit days", "credit period", "default credit period"],
    opening: ["opening balance", "opening", "closing balance", "balance", "outstanding", "amount due"],
  },
  suppliers: {},
  products: {
    name: ["name", "item name", "stock item", "stock item name", "product", "product name", "particulars", "item"],
    sku: ["sku", "code", "item code", "part no", "part number", "alias", "product code"],
    brand: ["brand", "stock group", "group", "make"],
    category: ["category", "stock category"],
    hsn: ["hsn", "hsn/sac", "hsn code", "hsn/sac code"],
    gstRate: ["gst rate", "gst %", "gst", "tax rate", "igst rate", "rate of tax", "integrated tax rate"],
    unit: ["unit", "uom", "units"],
    purchasePrice: ["purchase price", "cost", "purchase rate", "cost price"],
    dealerPrice: ["dealer price", "selling price", "sales price", "standard selling price", "sale price"],
    wholesalePrice: ["wholesale price"],
    retailPrice: ["retail price"],
    mrp: ["mrp", "m.r.p."],
    reorderLevel: ["reorder level", "reorder", "min stock", "minimum stock"],
    openingQty: ["opening qty", "opening quantity", "quantity", "closing quantity", "qty", "stock"],
    openingRate: ["opening rate", "rate", "rate per unit", "closing rate"],
    openingValue: ["opening value", "value", "closing value", "amount"],
    warrantyMonths: ["warranty", "warranty months"],
  },
};
ALIASES.suppliers = { ...ALIASES.customers, name: [...ALIASES.customers.name.filter((n) => n !== "customer name" && n !== "customer"), "supplier name", "supplier", "vendor"] };

const norm = (s: string) => s.toLowerCase().replace(/[\s_.:*()-]+/g, " ").trim();

export async function readTable(buf: Buffer, fileName: string): Promise<string[][]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
    const r = Papa.parse<string[]>(buf.toString("utf8").replace(/^﻿/, ""), { skipEmptyLines: true });
    return r.data.map((row) => row.map((c) => String(c ?? "").trim()));
  }
  if (lower.endsWith(".xlsx")) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new UserFacingError("The Excel file has no sheets.");
    const out: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const vals: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const v = cell.value as unknown;
        let t = "";
        if (v == null) t = "";
        else if (typeof v === "object" && v !== null && "result" in v) t = String((v as { result: unknown }).result ?? "");
        else if (typeof v === "object" && v !== null && "richText" in v) t = (v as { richText: { text: string }[] }).richText.map((x) => x.text).join("");
        else if (typeof v === "object" && v !== null && "text" in v) t = String((v as { text: unknown }).text);
        else if (v instanceof Date) t = v.toISOString().slice(0, 10);
        else t = String(v);
        vals[col - 1] = t.trim();
      });
      out.push(Array.from(vals, (x) => x ?? ""));
    });
    return out;
  }
  if (lower.endsWith(".xls")) throw new UserFacingError("Old .xls files aren't supported. In Excel, use File → Save As → .xlsx, or export as CSV.");
  throw new UserFacingError("Please upload an .xlsx or .csv file.");
}

/** Finds the header row (Tally exports have title rows first) and maps columns to fields. */
export function mapHeaders(table: string[][], kind: ImportKind) {
  const aliases = ALIASES[kind];
  let best = { row: -1, map: {} as Record<string, number>, score: 0 };
  for (let r = 0; r < Math.min(table.length, 20); r++) {
    const map: Record<string, number> = {};
    table[r].forEach((h, c) => {
      const n = norm(h ?? "");
      if (!n) return;
      for (const [field, list] of Object.entries(aliases)) if (map[field] === undefined && list.includes(n)) { map[field] = c; break; }
    });
    const score = Object.keys(map).length;
    if (map.name !== undefined && score > best.score) best = { row: r, map, score };
  }
  if (best.row < 0) throw new UserFacingError(`Couldn't find a "Name" column. The first row with headings should include a name column (e.g. "Name", "Ledger Name", "Item Name").`);
  return best;
}

/** "84,000.00 Dr" → 84000 with side. */
export function parseTallyAmount(raw: string) {
  const t = (raw ?? "").replace(/[₹,\s]/g, "");
  if (!t) return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)(Dr|Cr)?$/i);
  if (!m) return "INVALID" as const;
  return { amount: D(m[1]).abs(), side: (m[2]?.toLowerCase() ?? (m[1].startsWith("-") ? "neg" : "")) as "dr" | "cr" | "neg" | "" };
}
const stateCodeFrom = (v: string) => {
  const n = norm(v);
  if (!n) return undefined;
  return GST_STATES.find((s) => s.code === v.trim().padStart(2, "0") || norm(s.name) === n)?.code ?? "UNKNOWN";
};

export type PreviewRow = { rowNo: number; status: "ok" | "skip" | "error"; message?: string; data: Record<string, string> };

export async function buildPreview(db: DB, companyId: string, kind: ImportKind, table: string[][]) {
  const { row: headerRow, map } = mapHeaders(table, kind);
  const rows: PreviewRow[] = [];
  const seen = new Set<string>();
  const brands = await db.query.brands.findMany({ where: eq(schema.brands.companyId, companyId) });
  const brandNames = new Set(brands.map((b) => b.name.toLowerCase()));
  for (let r = headerRow + 1; r < table.length; r++) {
    const cells = table[r];
    const get = (f: string) => (map[f] !== undefined ? (cells[map[f]] ?? "").trim() : "");
    const data: Record<string, string> = {};
    for (const f of Object.keys(map)) data[f] = get(f);
    const rowNo = r + 1;
    const name = data.name;
    if (!name) continue;
    if (/^(grand )?total$/i.test(name)) continue; // Tally totals row
    const key = name.toLowerCase();
    if (seen.has(key)) { rows.push({ rowNo, status: "skip", message: "Appears twice in this file — only the first is kept.", data }); continue; }
    seen.add(key);
    try {
      if (kind === "products") {
        if (data.openingQty && !data.openingRate && data.openingValue) {
          const q = D(data.openingQty.replace(/[^\d.]/g, "") || "0"), v = D(data.openingValue.replace(/[^\d.]/g, "") || "0");
          if (q.gt(0)) data.openingRate = v.div(q).toDecimalPlaces(2).toFixed(2);
        }
        data.openingQty = (data.openingQty ?? "").replace(/[^\d.]/g, "");
        data.openingRate = (data.openingRate ?? "").replace(/[,₹\s]/g, "");
        data.gstRate = (data.gstRate ?? "").replace(/%/g, "").trim();
        const exists = await db.query.products.findFirst({ where: and(eq(schema.products.companyId, companyId), sql`lower(${schema.products.name}) = lower(${name})`) });
        if (exists) { rows.push({ rowNo, status: "skip", message: "Already in your product list.", data }); continue; }
        await validateProduct(db, companyId, { name, sku: data.sku, hsn: data.hsn, gstRate: data.gstRate, unit: data.unit,
          purchasePrice: data.purchasePrice, dealerPrice: data.dealerPrice, wholesalePrice: data.wholesalePrice, retailPrice: data.retailPrice,
          mrp: data.mrp, reorderLevel: data.reorderLevel, warrantyMonths: data.warrantyMonths?.replace(/\D/g, "") });
        if (data.openingQty && D(data.openingQty).gt(0) && !data.openingRate && !data.purchasePrice)
          throw new UserFacingError("Has opening stock but no rate/value — can't value it.");
        const notes = [];
        if (data.brand && !brandNames.has(data.brand.toLowerCase())) notes.push(`New brand "${data.brand}" will be added.`);
        if (data.gstRate) notes.push("GST rate will be marked unconfirmed until you check it.");
        rows.push({ rowNo, status: "ok", message: notes.join(" ") || undefined, data });
      } else {
        const type = kind === "customers" ? "CUSTOMER" : "SUPPLIER";
        const sc = data.state ? stateCodeFrom(data.state) : undefined;
        if (sc === "UNKNOWN") throw new UserFacingError(`State "${data.state}" not recognised.`);
        const input: PartyInput = { name, contactPerson: data.contactPerson, phone: data.phone, whatsapp: data.whatsapp, email: data.email,
          gstin: data.gstin, stateCode: sc, addressLine1: data.addressLine1, city: data.city, pincode: data.pincode,
          creditLimit: data.creditLimit, creditDays: data.creditDays };
        const v = validatePartyInput(input);
        const exists = await db.query.parties.findFirst({ where: and(eq(schema.parties.companyId, companyId), eq(schema.parties.type, type),
          sql`(lower(${schema.parties.name}) = lower(${name})${v.gstin ? sql` OR ${schema.parties.gstin} = ${v.gstin}` : sql``})`) });
        if (exists) { rows.push({ rowNo, status: "skip", message: `Already exists as "${exists.name}".`, data }); continue; }
        if (data.opening) {
          const a = parseTallyAmount(data.opening);
          if (a === "INVALID") throw new UserFacingError(`Opening balance "${data.opening}" isn't a number.`);
          if (a) {
            // Customers: Dr (or plain positive) = owes us. Suppliers: Cr (or plain positive) = we owe.
            const normal = type === "CUSTOMER" ? a.side === "dr" || a.side === "" : a.side === "cr" || a.side === "";
            data.openingSigned = (normal ? a.amount : a.amount.neg()).toFixed(2);
          }
        }
        rows.push({ rowNo, status: "ok", data });
      }
    } catch (e) {
      if (e instanceof UserFacingError) rows.push({ rowNo, status: "error", message: e.message, data });
      else throw e;
    }
  }
  const summary = { ok: rows.filter((r) => r.status === "ok").length, skip: rows.filter((r) => r.status === "skip").length,
    error: rows.filter((r) => r.status === "error").length, columns: Object.keys(map) };
  return { rows, summary };
}

export async function createPreview(db: DB, companyId: string, userId: string, kind: ImportKind, fileName: string, buf: Buffer) {
  if (buf.length > 5 * 1024 * 1024) throw new UserFacingError("File is larger than 5 MB. Please split it.");
  const table = await readTable(buf, fileName);
  if (table.length < 2) throw new UserFacingError("The file looks empty.");
  if (table.length > 5001) throw new UserFacingError("Please import at most 5,000 rows at a time.");
  const { rows, summary } = await buildPreview(db, companyId, kind, table);
  const [b] = await db.insert(schema.importBatches).values({ companyId, kind, fileName, rows, summary, createdBy: userId }).returning();
  return b;
}

/** Imports every OK row in ONE transaction. If anything fails, nothing is imported. */
export async function confirmImport(db: DB, companyId: string, userId: string, batchId: string, openingDate: string) {
  const b = await db.query.importBatches.findFirst({ where: and(eq(schema.importBatches.id, batchId), eq(schema.importBatches.companyId, companyId)) });
  if (!b || b.status !== "PREVIEW") throw new UserFacingError("This import was already completed or discarded.");
  const rows = (b.rows as PreviewRow[]).filter((r) => r.status === "ok");
  if (!rows.length) throw new UserFacingError("There are no rows ready to import.");
  let count = 0;
  await db.transaction(async (tx) => {
    const t = tx as unknown as DB;
    for (const r of rows) {
      const d = r.data;
      try {
        if (b.kind === "products") {
          let brandId: string | undefined;
          if (d.brand) {
            const found = await tx.query.brands.findFirst({ where: and(eq(schema.brands.companyId, companyId), sql`lower(${schema.brands.name}) = lower(${d.brand})`) });
            brandId = found?.id ?? (await addBrand(t, companyId, userId, d.brand)).id;
          }
          await createProduct(t, companyId, userId, { name: d.name, sku: d.sku, brandId, categoryName: d.category, hsn: d.hsn, gstRate: d.gstRate,
            unit: d.unit, purchasePrice: d.purchasePrice, dealerPrice: d.dealerPrice, wholesalePrice: d.wholesalePrice, retailPrice: d.retailPrice,
            mrp: d.mrp, reorderLevel: d.reorderLevel, warrantyMonths: d.warrantyMonths?.replace(/\D/g, ""),
            openingQty: d.openingQty, openingRate: d.openingRate, openingDate });
        } else {
          await createParty(t, companyId, userId, b.kind === "customers" ? "CUSTOMER" : "SUPPLIER", {
            name: d.name, contactPerson: d.contactPerson, phone: d.phone, whatsapp: d.whatsapp, email: d.email, gstin: d.gstin,
            stateCode: d.state ? stateCodeFrom(d.state) : undefined, addressLine1: d.addressLine1, city: d.city, pincode: d.pincode,
            creditLimit: d.creditLimit, creditDays: d.creditDays, openingBalance: d.openingSigned, openingDate });
        }
        count++;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new UserFacingError(`Row ${r.rowNo} (${d.name}): ${msg} Nothing was imported — fix this row or remove it and upload again.`);
      }
    }
    await tx.update(schema.importBatches).set({ status: "IMPORTED", summary: { ...(b.summary as object), imported: count, openingDate } }).where(eq(schema.importBatches.id, b.id));
    await audit(tx, { companyId, userId, action: `import.${b.kind}`, entityType: "import_batch", entityId: b.id, after: { file: b.fileName, imported: count }, source: "import" });
  });
  return count;
}

export const TEMPLATES: Record<ImportKind, string> = {
  customers: "Name,Phone,WhatsApp,GSTIN,State,Address,City,Pincode,Credit Limit,Credit Days,Opening Balance\nRavi Traders,9876543210,,21ABCDE1234F1Z5,Odisha,Main Road,Cuttack,753001,200000,30,84000 Dr\n",
  suppliers: "Name,Phone,GSTIN,State,Address,City,Credit Days,Opening Balance\nSF Distributors,9876500000,,Odisha,Industrial Area,Bhubaneswar,30,150000 Cr\n",
  products: "Name,Code,Brand,Category,HSN,GST Rate,Unit,Purchase Price,Dealer Price,Retail Price,MRP,Reorder Level,Opening Qty,Opening Rate,Warranty Months\nSF Sonic 35Ah,SF-35AH,SF Sonic,Batteries,8507,18,pcs,4500,5000,5400,6200,5,20,4500,24\n",
};
