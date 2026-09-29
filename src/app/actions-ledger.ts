"use server";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { cashPaymentWarnings } from "@/lib/services/sales";
import { requireContext } from "@/lib/session";
import { postEntry, reverseEntry } from "@/lib/accounting/engine";
import { recordReceipt, recordPayment, recordContra, setOpeningBalances } from "@/lib/services/vouchers";
import { resetUserPassword, setUserActive, changeOwnPassword, setSetupStep } from "@/lib/services/company";
import { UserFacingError } from "@/lib/errors";

const s = (f: FormData, k: string) => String(f.get(k) ?? "");
function fail(path: string, e: unknown, keep: Record<string, string> = {}): never {
  const msg = e instanceof UserFacingError ? e.message : "Something went wrong. Nothing was saved. Please try again.";
  if (!(e instanceof UserFacingError)) console.error(e);
  const q = new URLSearchParams({ ...keep, error: msg, ...(e instanceof UserFacingError && e.field ? { field: e.field } : {}) });
  redirect(`${path}${path.includes("?") ? "&" : "?"}${q}`);
}

export async function setViewModeAction(f: FormData) {
  (await cookies()).set("view_mode", s(f, "mode") === "accountant" ? "accountant" : "owner", { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  revalidatePath("/", "layout");
  redirect(s(f, "back") || "/home");
}

export async function recordMoneyAction(f: FormData) {
  const type = s(f, "type");
  const ctx = await requireContext(type === "journal" ? "ledger.post_manual" : "money.record");
  const base = { companyId: ctx.company.id, userId: ctx.user.id, date: s(f, "date"), amount: s(f, "amount"), narration: s(f, "narration") };
  const keep = { type, amount: s(f, "amount"), narration: s(f, "narration"), date: s(f, "date") };
  let entry;
  let cashWarn: string[] = [];
  try {
    if (type === "receipt") entry = await recordReceipt(db, { ...base, cashBankId: s(f, "cashBankId"), fromAccountId: s(f, "otherId") });
    else if (type === "payment") entry = await recordPayment(db, { ...base, cashBankId: s(f, "cashBankId"), toAccountId: s(f, "otherId") });
    if (type === "payment") {
      const cash = await db.query.accounts.findFirst({ where: and(eq(schema.accounts.id, s(f, "cashBankId")), eq(schema.accounts.systemKey, "CASH")) });
      if (cash) cashWarn = await cashPaymentWarnings(db, ctx.company.id, s(f, "date"), s(f, "amount").replace(/[,₹\s]/g, "") || "0");
    }
    else if (type === "contra") entry = await recordContra(db, { ...base, fromId: s(f, "fromId"), toId: s(f, "toId") });
    else if (type === "journal") {
      const lines = [];
      for (let i = 0; i < 10; i++) {
        const accountId = s(f, `acc${i}`), dr = s(f, `dr${i}`).replace(/,/g, ""), cr = s(f, `cr${i}`).replace(/,/g, "");
        if (!accountId && !dr && !cr) continue;
        lines.push({ accountId, debit: dr || "0", credit: cr || "0" });
      }
      entry = await postEntry(db, { companyId: ctx.company.id, userId: ctx.user.id, voucherType: "JOURNAL", date: s(f, "date"), narration: s(f, "narration"), lines });
    } else throw new UserFacingError("Unknown entry type.");
  } catch (e) { fail(`/money/new`, e, keep); }
  redirect(`/reports/entry/${entry!.id}?saved=1${cashWarn.length ? `&w=${encodeURIComponent(JSON.stringify(cashWarn))}` : ""}`);
}

export async function reverseEntryAction(f: FormData) {
  const ctx = await requireContext("transactions.cancel");
  const id = s(f, "entryId");
  let rev;
  try { rev = await reverseEntry(db, { companyId: ctx.company.id, userId: ctx.user.id, entryId: id, reason: s(f, "reason") }); }
  catch (e) { fail(`/reports/entry/${id}`, e); }
  redirect(`/reports/entry/${rev!.id}?reversed=1`);
}

export async function saveOpeningAction(f: FormData) {
  const ctx = await requireContext("ledger.post_manual");
  const back = s(f, "back") === "setup" ? "/setup?step=7" : "/settings/opening";
  const balances: Record<string, string> = {};
  for (const [k, v] of f.entries()) if (k.startsWith("bal_")) balances[k.slice(4)] = String(v);
  try {
    await setOpeningBalances(db, { companyId: ctx.company.id, userId: ctx.user.id, date: s(f, "date"), balances });
    if (back.startsWith("/setup")) await setSetupStep(db, ctx.company.id, Math.max(ctx.company.setupStep, 8));
  } catch (e) { fail(back, e); }
  redirect(back.startsWith("/setup") ? "/setup?step=8" : "/settings/opening?saved=1");
}

export async function resetPasswordAction(f: FormData) {
  const ctx = await requireContext("users.manage");
  try { await resetUserPassword(db, ctx.company.id, ctx.user.id, s(f, "userId"), s(f, "password")); }
  catch (e) { fail("/settings/users", e); }
  const u = await db.query.users.findFirst({ where: eq(schema.users.id, s(f, "userId")) });
  redirect(`/settings/users?msg=${encodeURIComponent(`Password changed for ${u?.name}. Share the new password with them.`)}`);
}

export async function toggleUserAction(f: FormData) {
  const ctx = await requireContext("users.manage");
  try { await setUserActive(db, ctx.company.id, ctx.user.id, s(f, "userId"), s(f, "active") === "1"); }
  catch (e) { fail("/settings/users", e); }
  redirect("/settings/users?msg=Saved.");
}

export async function changePasswordAction(f: FormData) {
  const ctx = await requireContext();
  try {
    if (s(f, "password") !== s(f, "confirm")) throw new UserFacingError("The two new passwords don't match.", "confirm");
    await changeOwnPassword(db, ctx.user.id, s(f, "current"), s(f, "password"));
  } catch (e) { fail("/settings/password", e); }
  redirect("/settings/password?saved=1");
}
