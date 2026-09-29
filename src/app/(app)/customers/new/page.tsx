import { requireContext } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { PartyForm } from "@/components/parties/form";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext("sales.create");
  return <><PageHeader title="Add customer" /><PartyForm type="CUSTOMER" sp={await searchParams} companyState={ctx.company.stateCode} /></>;
}
