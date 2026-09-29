import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { AccOpt } from "@/components/accounts-select";

/** All active accounts as picker options, labelled for owner or accountant view. */
export async function accountOptions(companyId: string, accountant: boolean) {
  const [groups, accs] = await Promise.all([
    db.query.accountGroups.findMany({ where: eq(schema.accountGroups.companyId, companyId) }),
    db.query.accounts.findMany({ where: eq(schema.accounts.companyId, companyId), orderBy: schema.accounts.code }),
  ]);
  const g = new Map(groups.map((x) => [x.id, x]));
  return accs.filter((a) => a.isActive).map((a) => ({
    id: a.id, code: a.code, label: accountant ? a.name : a.ownerLabel,
    group: accountant ? g.get(a.groupId)!.name : g.get(a.groupId)!.ownerLabel,
    groupCode: g.get(a.groupId)!.code, nature: a.nature, systemKey: a.systemKey,
  })) as (AccOpt & { groupCode: string; nature: string; systemKey: string | null })[];
}
