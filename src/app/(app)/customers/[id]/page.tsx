import { requireContext } from "@/lib/session";
import { can } from "@/lib/permissions";
import { PartyDetail } from "@/components/parties/detail";

export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext("view.dashboard");
  return <PartyDetail id={(await params).id} companyId={ctx.company.id} businessName={ctx.company.name} sp={await searchParams}
    canPay={can(ctx.role, "money.record")} canEdit={can(ctx.role, "sales.create")} />;
}
