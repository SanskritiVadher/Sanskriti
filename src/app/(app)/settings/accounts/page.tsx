import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";

export default async function Accounts() {
  const ctx = await requireContext();
  const [groups, accounts] = await Promise.all([
    db.query.accountGroups.findMany({ where: eq(schema.accountGroups.companyId, ctx.company.id), orderBy: asc(schema.accountGroups.code) }),
    db.query.accounts.findMany({ where: eq(schema.accounts.companyId, ctx.company.id), orderBy: asc(schema.accounts.code) }),
  ]);
  const top = groups.filter((g) => !g.parentId);
  const kids = (id: string) => groups.filter((g) => g.parentId === id);
  const accs = (id: string) => accounts.filter((a) => a.groupId === id);
  const render = (gId: string, depth: number): React.ReactNode => <>
    {accs(gId).map((a) => <li key={a.id} className="flex justify-between py-1.5" style={{ paddingLeft: depth * 16 }}>
      <span>{a.ownerLabel}{a.ownerLabel !== a.name && <span className="ml-2 text-[13px] text-ink-3">({a.name})</span>}</span>
      <span className="num text-[13px] text-ink-3">{a.code}</span></li>)}
    {kids(gId).map((g) => <li key={g.id}>
      <p className="pt-3 pb-1 text-[14px] font-semibold text-ink-2" style={{ paddingLeft: depth * 16 }}>{g.ownerLabel}</p>
      <ul>{render(g.id, depth + 1)}</ul></li>)}
  </>;
  return <>
    <PageHeader title="Chart of accounts" subtitle="Every rupee is recorded in one of these. Created for you automatically." />
    <div className="grid gap-6 md:grid-cols-2">{top.map((g) => <Card key={g.id}>
      <h2 className="text-[18px] font-semibold">{g.ownerLabel}</h2><p className="text-[13px] text-ink-3">{g.name}</p>
      <ul className="mt-2 text-[15px]">{render(g.id, 0)}</ul></Card>)}</div>
  </>;
}
