"use server";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { UserFacingError } from "@/lib/errors";
import { recordContra, recordPayment, recordReceipt } from "@/lib/services/vouchers";
import { recordCustomerPayment, recordSupplierPayment } from "@/lib/services/parties";
import { cashPaymentWarnings, cashReceiptWarnings } from "@/lib/services/sales";
import { audit } from "@/lib/services/audit";
import { markChecked } from "@/lib/analytics/anomalies";

const s = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

/** Posts ONLY what the owner saw and confirmed on the review screen. */
export async function confirmQuickEntryAction(f: FormData) {
  const ctx = await requireContext("money.record");
  const kind = s(f, "kind"), text = s(f, "text");
  const base = { companyId: ctx.company.id, userId: ctx.user.id, date: s(f, "date"), amount: s(f, "amount"), narration: s(f, "narration") };
  const cb = s(f, "cashBankId"), other = s(f, "otherId"), party = s(f, "partyId");
  let entry: { id: string } | undefined; let warn: string[] = [];
  try {
    if (!f.get("confirm")) throw new UserFacingError("Tick 'I've checked this' before saving.");
    const isCash = async (id: string) => !!(await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, id), eq(schema.accounts.systemKey, "CASH")) }));
    const amt = base.amount.replace(/[,₹\s]/g, "") || "0";
    if (kind === "CUSTOMER_PAYMENT") {
      if (!party) throw new UserFacingError("Choose the customer.");
      entry = await recordCustomerPayment(db, { ...base, partyId: party, cashBankId: cb });
      if (await isCash(cb)) warn = await cashReceiptWarnings(db, ctx.company.id, party, base.date);
    } else if (kind === "SUPPLIER_PAYMENT") {
      if (!party) throw new UserFacingError("Choose the supplier.");
      entry = await recordSupplierPayment(db, { ...base, partyId: party, cashBankId: cb });
      if (await isCash(cb)) warn = await cashPaymentWarnings(db, ctx.company.id, base.date, amt, party);
    } else if (kind === "EXPENSE" || kind === "DRAWINGS") {
      if (!other) throw new UserFacingError("Choose what it was paid for.");
      entry = await recordPayment(db, { ...base, cashBankId: cb, toAccountId: other });
      if (kind === "EXPENSE" && await isCash(cb)) warn = await cashPaymentWarnings(db, ctx.company.id, base.date, amt);
    } else if (kind === "MONEY_IN") {
      if (!other) throw new UserFacingError("Choose where the money came from.");
      entry = await recordReceipt(db, { ...base, cashBankId: cb, fromAccountId: other });
    } else if (kind === "DEPOSIT" || kind === "WITHDRAW") {
      entry = await recordContra(db, { ...base, fromId: s(f, "fromId"), toId: s(f, "toId") });
    } else throw new UserFacingError("Choose what kind of entry this is.");
  } catch (e) {
    const msg = e instanceof UserFacingError ? e.message : "Couldn't save. Nothing was recorded.";
    redirect(`/assistant?q=${encodeURIComponent(text)}&error=${encodeURIComponent(msg)}`);
  }
  await audit(db, { companyId: ctx.company.id, userId: ctx.user.id, action: "assist.quick_entry", entityType: "journal_entry", entityId: entry!.id, after: { typed: text, kind }, source: "quick-entry" }).catch(() => {});
  redirect(`/reports/entry/${entry!.id}?saved=1${warn.length ? `&w=${encodeURIComponent(JSON.stringify(warn))}` : ""}`);
}

export async function markCheckedAction(f: FormData) {
  const ctx = await requireContext("reports.financial");
  await markChecked(db, ctx.company.id, ctx.user.id, s(f, "key"), s(f, "note"));
  redirect("/assistant/checks?ok=1");
}
