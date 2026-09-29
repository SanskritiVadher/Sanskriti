import { and, eq, asc } from "drizzle-orm";
import { schema, type DB } from "@/db";
import { UserFacingError } from "@/lib/errors";
import { audit } from "./audit";

export async function listPeriods(db: DB, companyId: string) {
  return db.query.financialPeriods.findMany({ where: eq(schema.financialPeriods.companyId, companyId), orderBy: asc(schema.financialPeriods.startDate) });
}
/** Lock a finished financial year so nothing dated inside it can be added or changed. */
export async function setPeriodLock(db: DB, p: { companyId: string; userId: string; periodId: string; lock: boolean; reason: string; role: string }) {
  const per = await db.query.financialPeriods.findFirst({ where: and(eq(schema.financialPeriods.id, p.periodId), eq(schema.financialPeriods.companyId, p.companyId)) });
  if (!per) throw new UserFacingError("Year not found.");
  if (!p.lock && p.role !== "OWNER") throw new UserFacingError("Only the owner can reopen a locked year.");
  if (!p.reason.trim()) throw new UserFacingError("Please give a reason.");
  if (p.lock && per.endDate >= new Date().toISOString().slice(0, 10)) throw new UserFacingError("A year can be locked only after it ends.");
  await db.update(schema.financialPeriods).set({ isClosed: p.lock }).where(eq(schema.financialPeriods.id, per.id));
  await audit(db, { companyId: p.companyId, userId: p.userId, action: p.lock ? "period.lock" : "period.unlock", entityType: "financial_period", entityId: per.id,
    before: { isClosed: per.isClosed }, after: { isClosed: p.lock }, reason: p.reason.trim() });
}
