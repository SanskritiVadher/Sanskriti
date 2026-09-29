"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { sql } from "drizzle-orm";
import { restoreCompany, unpackBackup } from "@/lib/services/backup";
import { ledgerHealth } from "@/lib/accounting/reports";
import { db } from "@/db";
import { startSession, endSession, requireContext } from "@/lib/session";
import {
  registerOwner, authenticate, updateBusinessInfo, updateGstInfo, addBankAccount, addBrand,
  setSetupStep, addUser, UserFacingError, signupOpen, logoutEverywhere,
} from "@/lib/services/company";

const s = (f: FormData, k: string) => String(f.get(k) ?? "");
const back = (path: string, e: unknown): never => {
  if (e instanceof UserFacingError) {
    const q = new URLSearchParams({ error: e.message, ...(e.field ? { field: e.field } : {}) });
    redirect(`${path}${path.includes("?") ? "&" : "?"}${q}`);
  }
  console.error(e);
  redirect(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent("Something went wrong while saving. Nothing was changed. Please try again.")}`);
};

export async function signupAction(f: FormData) {
  // Refuse before creating anything if login can't work (prevents a half-created account).
  if ((process.env.AUTH_SECRET ?? "").length < 32)
    redirect(`/signup?error=${encodeURIComponent("The app isn't fully set up yet (login secret missing). Please ask whoever deployed it to add AUTH_SECRET. No account was created.")}`);
  if (!(await signupOpen(db))) redirect(`/signup?error=${encodeURIComponent("New sign-ups are closed. Ask the owner to add you under Settings → Team.")}`);
  let r;
  try {
    r = await registerOwner(db, { name: s(f, "name"), email: s(f, "email"), password: s(f, "password"), businessName: s(f, "businessName") });
  } catch (e) { back("/signup", e); }
  await startSession({ userId: r!.user.id, companyId: r!.company.id });
  redirect("/setup?step=1");
}

/** Only on a brand-new, empty database: load a backup file (disaster recovery). */
export async function restoreBackupAction(f: FormData) {
  const n = await db.execute<{ n: number }>(sql`SELECT count(*)::int n FROM users`);
  if (n.rows[0].n > 0) redirect("/login");
  const file = f.get("backup");
  let msg = "";
  try {
    if (!(file instanceof File) || file.size === 0) throw new UserFacingError("Choose the backup file.");
    const r = await restoreCompany(db, unpackBackup(Buffer.from(await file.arrayBuffer())));
    const failed = (await ledgerHealth(db, r.companyId)).filter((h) => !h.ok);
    if (failed.length) msg = `Restored, but these checks failed: ${failed.map((x) => x.name).join(", ")}.`;
  } catch (e) { redirect(`/signup?error=${encodeURIComponent(e instanceof UserFacingError ? e.message : "Couldn't restore that file.")}`); }
  redirect(`/login?restored=1${msg ? `&warn=${encodeURIComponent(msg)}` : ""}`);
}

export async function loginAction(f: FormData) {
  let r;
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0].trim() || h.get("x-real-ip") || null;
  try { r = await authenticate(db, s(f, "email"), s(f, "password"), ip); } catch (e) { back("/login", e); }
  await startSession({ userId: r!.user.id, companyId: r!.companyId });
  redirect("/home");
}

export async function logoutAction() { await endSession(); redirect("/login"); }
export async function logoutEverywhereAction() {
  const ctx = await requireContext();
  await logoutEverywhere(db, ctx.user.id);
  await endSession(); redirect("/login");
}

export async function saveBusinessAction(f: FormData) {
  const ctx = await requireContext("company.edit");
  const next = s(f, "next");
  try {
    await updateBusinessInfo(db, ctx.company.id, ctx.user.id, {
      name: s(f, "name"), legalName: s(f, "legalName"), phone: s(f, "phone"), email: s(f, "email"),
      addressLine1: s(f, "addressLine1"), addressLine2: s(f, "addressLine2"), city: s(f, "city"),
      pincode: s(f, "pincode"), stateCode: s(f, "stateCode") || undefined,
    });
    if (next === "setup") await setSetupStep(db, ctx.company.id, Math.max(ctx.company.setupStep, 2));
  } catch (e) { back(next === "setup" ? "/setup?step=1" : "/settings", e); }
  revalidatePath("/", "layout");
  redirect(next === "setup" ? "/setup?step=2" : "/settings?saved=1");
}

export async function saveGstAction(f: FormData) {
  const ctx = await requireContext("gst.configure");
  const next = s(f, "next");
  try {
    await updateGstInfo(db, ctx.company.id, ctx.user.id, {
      registration: s(f, "registration") as "REGULAR" | "COMPOSITION" | "UNREGISTERED", gstin: s(f, "gstin") });
    if (next === "setup") await setSetupStep(db, ctx.company.id, Math.max(ctx.company.setupStep, 3));
  } catch (e) {
    const typed = encodeURIComponent(s(f, "gstin"));
    back(next === "setup" ? `/setup?step=2&gstin=${typed}` : `/settings?gstin=${typed}`, e);
  }
  redirect(next === "setup" ? "/setup?step=3" : "/settings?saved=1");
}

export async function addBankAction(f: FormData) {
  const ctx = await requireContext("company.edit");
  try {
    await addBankAccount(db, ctx.company.id, ctx.user.id, {
      bankName: s(f, "bankName"), accountHolder: s(f, "accountHolder"), accountNumber: s(f, "accountNumber"), ifsc: s(f, "ifsc") });
  } catch (e) { back("/setup?step=3", e); }
  redirect("/setup?step=3&added=1");
}

export async function addBrandAction(f: FormData) {
  const ctx = await requireContext("company.edit");
  try { await addBrand(db, ctx.company.id, ctx.user.id, s(f, "name")); } catch (e) { back("/setup?step=4", e); }
  redirect("/setup?step=4");
}

export async function goToStepAction(f: FormData) {
  const ctx = await requireContext("company.edit");
  const step = Number(s(f, "step"));
  const finish = s(f, "finish") === "1";
  await setSetupStep(db, ctx.company.id, Math.max(ctx.company.setupStep, step), finish);
  redirect(finish ? "/home?welcome=1" : `/setup?step=${step}`);
}

export async function addUserAction(f: FormData) {
  const ctx = await requireContext("users.manage");
  try {
    await addUser(db, ctx.company.id, ctx.user.id, {
      name: s(f, "name"), email: s(f, "email"), password: s(f, "password"),
      role: s(f, "role") as "ADMIN" | "ACCOUNTANT" | "SALESPERSON" | "PURCHASE_MANAGER" | "INVENTORY_MANAGER" | "VIEWER" });
  } catch (e) { back("/settings/users", e); }
  redirect("/settings/users?added=1");
}
