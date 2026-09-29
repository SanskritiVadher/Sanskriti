"use server";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { requireContext } from "@/lib/session";
import { DEFS, saveTargets } from "@/lib/analytics/ratios";
import { saveReorderSettings } from "@/lib/analytics/stock";
import { audit } from "@/lib/services/audit";

export async function saveTargetsAction(f: FormData) {
  const ctx = await requireContext("company.edit");
  const t: Record<string, number> = {};
  for (const d of DEFS) {
    const v = String(f.get(`t_${d.key}`) ?? "").trim();
    if (!v) continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100000) redirect(`/settings/targets?error=${encodeURIComponent(`"${d.ownerName}" must be a positive number.`)}`);
    t[d.key] = n;
  }
  await saveTargets(db, ctx.company.id, t);
  await audit(db, { companyId: ctx.company.id, userId: ctx.user.id, action: "settings.ratio_targets", entityType: "settings", entityId: ctx.company.id, after: t });
  redirect("/settings/targets?saved=1");
}

export async function saveReorderAction(f: FormData) {
  const ctx = await requireContext("company.edit");
  const n = (k: string) => Number(f.get(k));
  const s = { leadDays: n("leadDays"), coverDays: n("coverDays"), safetyDays: n("safetyDays"), lookbackDays: n("lookbackDays") };
  if (Object.values(s).some((v) => !Number.isInteger(v) || v < 0 || v > 365) || s.lookbackDays < 30)
    redirect(`/settings/targets?error=${encodeURIComponent("Days must be whole numbers from 0 to 365; look-back at least 30.")}`);
  await saveReorderSettings(db, ctx.company.id, s);
  await audit(db, { companyId: ctx.company.id, userId: ctx.user.id, action: "settings.reorder", entityType: "settings", entityId: ctx.company.id, after: s });
  redirect("/settings/targets?saved=1");
}
