import { requireContext } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { PartyForm } from "@/components/parties/form";

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext("purchases.create");
  return <><PageHeader title="Add supplier" /><PartyForm type="SUPPLIER" sp={await searchParams} companyState={ctx.company.stateCode} /></>;
}
