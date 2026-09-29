import { NextResponse } from "next/server";
import { db } from "@/db";
import { getContext } from "@/lib/session";
import { getInvoice } from "@/lib/services/sales";
import { invoicePdf } from "@/lib/pdf/invoice";

export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getContext();
  if (!ctx) return NextResponse.redirect(new URL("/login", _.url));
  const d = await getInvoice(db, { companyId: ctx.company.id, id: (await params).id });
  if (!d) return new NextResponse("Not found", { status: 404 });
  const pdf = await invoicePdf(d);
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${d.inv.number.replace(/\//g, "-")}.pdf"`, "Cache-Control": "private, no-store" } });
}
