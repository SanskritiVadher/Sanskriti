"use server";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { UserFacingError } from "@/lib/errors";
import { setPeriodLock } from "@/lib/services/periods";

export async function periodLockAction(f: FormData) {
  const ctx = await requireContext("company.edit");
  try { await setPeriodLock(db, { companyId: ctx.company.id, userId: ctx.user.id, periodId: String(f.get("id")), lock: f.get("lock") === "1", reason: String(f.get("reason") ?? ""), role: ctx.role }); }
  catch (e) { redirect(`/settings/years?error=${encodeURIComponent(e instanceof UserFacingError ? e.message : "Couldn't change the lock.")}`); }
  redirect("/settings/years?saved=1");
}
