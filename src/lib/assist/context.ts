import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { accountOptions } from "@/lib/accounting/options";
import type { QAccount, QParty } from "./quick-entry";

export async function quickEntryContext(companyId: string) {
  const [parties, accs] = await Promise.all([
    db.query.parties.findMany({ where: and(eq(schema.parties.companyId, companyId), eq(schema.parties.isActive, true)), orderBy: schema.parties.name }),
    accountOptions(companyId, false),
  ]);
  const qp: QParty[] = parties.map((p) => ({ id: p.id, name: p.name, type: p.type as QParty["type"] }));
  const qa: QAccount[] = accs.map((a) => ({ id: a.id, systemKey: a.systemKey, label: a.label, groupCode: a.groupCode }));
  const cashBank = accs.filter((a) => a.groupCode === "1110" || a.groupCode === "1120");
  const blocked = ["DEBTORS_CONTROL", "CREDITORS_CONTROL", "INVENTORY", "COGS"];
  const others = accs.filter((a) => !cashBank.includes(a) && !blocked.includes(a.systemKey ?? ""));
  return { parties: qp, accounts: qa, cashBank, expenseOpts: others.filter((o) => ["EXPENSE", "ASSET", "LIABILITY"].includes(o.nature) || o.systemKey === "DRAWINGS"),
    incomeOpts: others.filter((o) => ["INCOME", "EQUITY", "LIABILITY"].includes(o.nature)) };
}
