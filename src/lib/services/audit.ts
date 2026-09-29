import { schema, type Tx, type DB } from "@/db";

export async function audit(
  q: Tx | DB,
  e: { companyId?: string | null; userId?: string | null; action: string; entityType: string; entityId?: string | null;
       before?: unknown; after?: unknown; reason?: string; source?: string },
) {
  await q.insert(schema.auditLogs).values({
    companyId: e.companyId ?? null, userId: e.userId ?? null, action: e.action, entityType: e.entityType,
    entityId: e.entityId ?? null, before: e.before ?? null, after: e.after ?? null, reason: e.reason, source: e.source ?? "app",
  });
}
