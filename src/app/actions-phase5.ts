"use server";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { UserFacingError } from "@/lib/errors";
import { createCreditNote, createDebitNote } from "@/lib/services/notes";
import { import2b, addRule, confirmRule, applyRuleToProducts, recordGstPayment, STARTER_RULES, setGstStrict, confirmProductRates } from "@/lib/services/gst";

const s = (f: FormData, k: string) => String(f.get(k) ?? "");
const msg = (e: unknown) => (e instanceof UserFacingError ? e.message : (console.error(e), "Something went wrong. Nothing was saved."));
const lines = (f: FormData) => [...f.entries()].filter(([k]) => k.startsWith("ret_")).map(([k, v]) => ({ sourceLineId: k.slice(4), qty: String(v) }));

export async function creditNoteAction(f: FormData) {
  const ctx = await requireContext("sales.create");
  const id = s(f, "invoiceId");
  let n;
  try { n = await createCreditNote(db, { companyId: ctx.company.id, userId: ctx.user.id, invoiceId: id, date: s(f, "date"), reason: s(f, "reason"), lines: lines(f) }); }
  catch (e) { redirect(`/sell/${id}/return?error=${encodeURIComponent(msg(e))}`); }
  redirect(`/sell/${id}?returned=${encodeURIComponent(n!.number)}`);
}
export async function debitNoteAction(f: FormData) {
  const ctx = await requireContext("purchases.create");
  const id = s(f, "billId");
  let n;
  try { n = await createDebitNote(db, { companyId: ctx.company.id, userId: ctx.user.id, billId: id, date: s(f, "date"), reason: s(f, "reason"), lines: lines(f) }); }
  catch (e) { redirect(`/buy/${id}/return?error=${encodeURIComponent(msg(e))}`); }
  redirect(`/buy/${id}?returned=${encodeURIComponent(n!.number)}`);
}
export async function upload2bAction(f: FormData) {
  const ctx = await requireContext("gst.configure");
  const file = f.get("file");
  let imp;
  try {
    if (!(file instanceof File) || !file.size) throw new UserFacingError("Choose the JSON file you downloaded from the GST portal.");
    if (file.size > 10 * 1024 * 1024) throw new UserFacingError("File is too large (over 10 MB).");
    imp = await import2b(db, ctx.company.id, ctx.user.id, s(f, "period"), file.name, await file.text());
  } catch (e) { redirect(`/gst/2b?error=${encodeURIComponent(msg(e))}`); }
  redirect(`/gst/2b/${imp!.id}`);
}
export async function addRuleAction(f: FormData) {
  const ctx = await requireContext("gst.configure");
  try {
    await addRule(db, ctx.company.id, ctx.user.id, { hsnPrefix: s(f, "hsn"), description: s(f, "description"), rate: s(f, "rate"), effectiveFrom: s(f, "from"),
      sourceName: s(f, "sourceName"), sourceUrl: s(f, "sourceUrl"), status: (s(f, "status") || "UNVERIFIED") as "UNVERIFIED", notes: s(f, "notes") });
  } catch (e) { redirect(`/gst/rates?error=${encodeURIComponent(msg(e))}`); }
  redirect("/gst/rates?saved=1");
}
export async function starterRulesAction() {
  const ctx = await requireContext("gst.configure");
  for (const r of STARTER_RULES) await addRule(db, ctx.company.id, ctx.user.id, { ...r, status: "SECONDARY_SOURCE" });
  redirect("/gst/rates?saved=1");
}
export async function confirmRuleAction(f: FormData) {
  const ctx = await requireContext("gst.configure");
  let n = 0;
  try {
    await confirmRule(db, ctx.company.id, ctx.user.id, s(f, "id"), s(f, "status") === "VERIFIED" ? "VERIFIED" : "USER_CONFIRMED", s(f, "sourceUrl"));
    if (s(f, "apply") === "1") n = await applyRuleToProducts(db, ctx.company.id, ctx.user.id, s(f, "id"));
  } catch (e) { redirect(`/gst/rates?error=${encodeURIComponent(msg(e))}`); }
  redirect(`/gst/rates?saved=1&applied=${n}`);
}
export async function gstPaymentAction(f: FormData) {
  const ctx = await requireContext("gst.configure");
  let r;
  try { r = await recordGstPayment(db, { companyId: ctx.company.id, userId: ctx.user.id, asOf: s(f, "asOf"), paidOn: s(f, "paidOn"), bankId: s(f, "bankId"), reference: s(f, "reference") }); }
  catch (e) { redirect(`/gst/pay?period=${s(f, "period")}&error=${encodeURIComponent(msg(e))}`); }
  redirect(`/reports/entry/${r!.entry.id}?saved=1`);
}

export async function gstStrictAction(f: FormData) {
  const ctx = await requireContext("gst.configure");
  await setGstStrict(db, ctx.company.id, ctx.user.id, s(f, "on") === "1");
  redirect("/gst/rates?saved=1");
}
export async function confirmProductRatesAction(f: FormData) {
  const ctx = await requireContext("gst.configure");
  let n = 0;
  try { n = await confirmProductRates(db, ctx.company.id, ctx.user.id, f.getAll("pid").map(String), s(f, "checkedAgainst")); }
  catch (e) { redirect(`/gst/rates?error=${encodeURIComponent(msg(e))}#products`); }
  redirect(`/gst/rates?confirmed=${n}#products`);
}
