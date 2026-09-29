import { and, desc, eq, gte, lte, ilike, sql } from "drizzle-orm";
import { schema, type DB } from "@/db";

export async function auditLog(db: DB, companyId: string, f: { from?: string; to?: string; q?: string; page?: number }) {
  const page = Math.max(1, f.page ?? 1), size = 50;
  const where = and(eq(schema.auditLogs.companyId, companyId),
    f.from ? gte(schema.auditLogs.createdAt, new Date(f.from + "T00:00:00+05:30")) : undefined,
    f.to ? lte(schema.auditLogs.createdAt, new Date(f.to + "T23:59:59+05:30")) : undefined,
    f.q ? ilike(schema.auditLogs.action, `%${f.q}%`) : undefined);
  const rows = await db.select({ a: schema.auditLogs, user: schema.users.name }).from(schema.auditLogs)
    .leftJoin(schema.users, eq(schema.users.id, schema.auditLogs.userId)).where(where)
    .orderBy(desc(schema.auditLogs.createdAt)).limit(size + 1).offset((page - 1) * size);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(where);
  return { rows: rows.slice(0, size), more: rows.length > size, page, total: n };
}

/** Human-readable before → after for changed top-level fields. */
export function diff(before: unknown, after: unknown) {
  const b = (before ?? {}) as Record<string, unknown>, a = (after ?? {}) as Record<string, unknown>;
  const skip = new Set(["updatedAt", "createdAt", "passwordHash", "id", "companyId"]);
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter((k) => !skip.has(k) && JSON.stringify(b[k]) !== JSON.stringify(a[k]))
    .map((k) => ({ field: k, from: b[k], to: a[k] }));
}
