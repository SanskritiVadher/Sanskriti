import { NextResponse } from "next/server";
import { db } from "@/db";
import { getInvoice } from "@/lib/services/sales";
import { invoicePdf } from "@/lib/pdf/invoice";

export const dynamic = "force-dynamic";
export async function GET(_: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,}$/.test(token)) return new NextResponse("Not found", { status: 404 });
  const d = await getInvoice(db, { token });
  if (!d) return new NextResponse("Not found", { status: 404 });
  const pdf = await invoicePdf(d);
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${d.inv.number.replace(/\//g, "-")}.pdf"`, "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store" } });
}
