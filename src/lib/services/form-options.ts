import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { stockList } from "./inventory";
import { partyBalances } from "./parties";
import { cashBankAccounts } from "./vouchers";
import { ageing } from "./receivables";
import type { PartyOpt, ProductOpt } from "@/components/docs/bill-form";
import { todayIST } from "@/lib/dates";

export async function billFormOptions(companyId: string, type: "CUSTOMER" | "SUPPLIER") {
  const [parties, bal, stock, cb, age] = await Promise.all([
    db.query.parties.findMany({ where: and(eq(schema.parties.companyId, companyId), eq(schema.parties.type, type), eq(schema.parties.isActive, true)), orderBy: schema.parties.name }),
    partyBalances(db, companyId, type), stockList(db, companyId), cashBankAccounts(db, companyId),
    type === "CUSTOMER" ? ageing(db, companyId, "CUSTOMER", todayIST()) : null,
  ]);
  const ov = new Map((age?.parties ?? []).map((p) => [p.id, p]));
  const partyOpts: PartyOpt[] = parties.map((p) => ({ id: p.id, name: p.name, state: p.stateCode, gstin: p.gstin, priceLevel: p.priceLevel,
    creditLimit: p.creditLimit, creditDays: p.creditDays, balance: (bal.get(p.id)?.balance ?? 0).toString(),
    overdue: (ov.get(p.id)?.overdue ?? 0).toString(), oldestOverdueDays: ov.get(p.id)?.oldest ?? 0 }));
  const productOpts: ProductOpt[] = stock.filter((s) => s.isActive).map((s) => ({ id: s.id, name: s.name, sku: s.sku, unit: s.unit, gstRate: s.gstRate,
    gstConfirmed: s.gstRateStatus === "USER_CONFIRMED", stock: s.qty.toString(), avgCost: s.avgCost.toFixed(4), dealer: s.dealerPrice,
    wholesale: null, retail: s.retailPrice, purchase: s.purchasePrice, minPrice: null, hsn: s.hsn }));
  // stockList doesn't carry wholesale/min price; fill from products.
  const prods = new Map((await db.query.products.findMany({ where: eq(schema.products.companyId, companyId) })).map((p) => [p.id, p]));
  for (const o of productOpts) { const p = prods.get(o.id)!; o.wholesale = p.wholesalePrice; o.minPrice = p.minSellingPrice; }
  return { partyOpts, productOpts, cashBank: cb.map((a) => ({ id: a.id, label: a.ownerLabel })) };
}
