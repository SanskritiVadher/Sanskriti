import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { PartyList } from "@/components/parties/list";

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; imported?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  return <PartyList type="CUSTOMER" companyId={ctx.company.id} q={sp.q} imported={sp.imported} businessName={ctx.company.name} canEdit={can(ctx.role, "sales.create")} />;
}
