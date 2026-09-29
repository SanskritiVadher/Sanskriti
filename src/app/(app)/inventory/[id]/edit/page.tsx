import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { ProductForm } from "@/components/product-form";

export default async function EditProduct({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const ctx = await requireContext("inventory.adjust");
  const { id } = await params;
  const p = await db.query.products.findFirst({ where: and(eq(schema.products.id, id), eq(schema.products.companyId, ctx.company.id)) });
  if (!p) notFound();
  const cat = p.categoryId ? await db.query.categories.findFirst({ where: eq(schema.categories.id, p.categoryId) }) : null;
  return <><PageHeader title={`Edit ${p.name}`} /><ProductForm companyId={ctx.company.id} product={p as never} categoryName={cat?.name} sp={await searchParams} /></>;
}
