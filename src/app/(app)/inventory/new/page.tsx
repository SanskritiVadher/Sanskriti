import { requireContext } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { ProductForm } from "@/components/product-form";

export default async function NewProduct({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext("inventory.adjust");
  return <><PageHeader title="Add product" /><ProductForm companyId={ctx.company.id} sp={await searchParams} /></>;
}
