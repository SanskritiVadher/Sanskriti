"use server";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { UserFacingError } from "@/lib/errors";
import { createSale, cancelSale, CreditLimitError, type SaleLineInput } from "@/lib/services/sales";
import { createBill, cancelBill, type BillLineInput } from "@/lib/services/purchases";

export type DocState = { error?: string; credit?: { message: string; limit: string; current: string; projected: string; overdue: string } } | undefined;
const s = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function saveSaleAction(_: DocState, f: FormData): Promise<DocState> {
  const ctx = await requireContext("sales.create");
  let res;
  try {
    const lines = JSON.parse(s(f, "lines") || "[]") as SaleLineInput[];
    const paid = s(f, "paidAmount").trim();
    res = await createSale(db, { companyId: ctx.company.id, userId: ctx.user.id, partyId: s(f, "partyId"), date: s(f, "date"), lines,
      paidNow: paid ? { amount: paid, cashBankId: s(f, "cashBankId") } : undefined, notes: s(f, "notes"), creditOverrideReason: s(f, "overrideReason") });
  } catch (e) {
    if (e instanceof CreditLimitError) return { credit: { message: e.message, ...e.details } };
    if (e instanceof UserFacingError) return { error: e.message };
    console.error(e);
    return { error: "Something went wrong. The bill was NOT saved. Please try again." };
  }
  const w = res.warnings.length ? `&w=${encodeURIComponent(JSON.stringify(res.warnings))}` : "";
  redirect(`/sell/${res.invoice.id}?saved=1${w}`);
}

export async function saveBillAction(_: DocState, f: FormData): Promise<DocState> {
  const ctx = await requireContext("purchases.create");
  let res;
  try {
    const lines = JSON.parse(s(f, "lines") || "[]") as BillLineInput[];
    const paid = s(f, "paidAmount").trim();
    res = await createBill(db, { companyId: ctx.company.id, userId: ctx.user.id, partyId: s(f, "partyId"), billNumber: s(f, "billNumber"), date: s(f, "date"),
      lines, paidNow: paid ? { amount: paid, cashBankId: s(f, "cashBankId") } : undefined, notes: s(f, "notes") });
  } catch (e) {
    if (e instanceof UserFacingError) return { error: e.message };
    console.error(e);
    return { error: "Something went wrong. The bill was NOT saved. Please try again." };
  }
  const w = res.warnings.length ? `&w=${encodeURIComponent(JSON.stringify(res.warnings))}` : "";
  redirect(`/buy/${res.bill.id}?saved=1${w}`);
}

export async function cancelSaleAction(f: FormData) {
  const ctx = await requireContext("transactions.cancel");
  const id = s(f, "id");
  try { await cancelSale(db, { companyId: ctx.company.id, userId: ctx.user.id, invoiceId: id, reason: s(f, "reason") }); }
  catch (e) { redirect(`/sell/${id}?error=${encodeURIComponent(e instanceof UserFacingError ? e.message : "Couldn't cancel. Nothing changed.")}`); }
  redirect(`/sell/${id}?cancelled=1`);
}

export async function cancelBillAction(f: FormData) {
  const ctx = await requireContext("transactions.cancel");
  const id = s(f, "id");
  try { await cancelBill(db, { companyId: ctx.company.id, userId: ctx.user.id, billId: id, reason: s(f, "reason") }); }
  catch (e) { redirect(`/buy/${id}?error=${encodeURIComponent(e instanceof UserFacingError ? e.message : "Couldn't cancel. Nothing changed.")}`); }
  redirect(`/buy/${id}?cancelled=1`);
}
