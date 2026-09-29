import { NextResponse } from "next/server";
import { db } from "@/db";
import { getContext } from "@/lib/session";
import { exportCompany, packBackup } from "@/lib/services/backup";
import { audit } from "@/lib/services/audit";
import { todayIST } from "@/lib/dates";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** Owner only: the file holds everything, including login password hashes. */
export async function GET() {
  const ctx = await getContext();
  if (!ctx || ctx.role !== "OWNER") return new NextResponse("Only the owner can download a backup.", { status: 403 });
  const b = await exportCompany(db, ctx.company.id);
  const buf = packBackup(b);
  await audit(db, { companyId: ctx.company.id, userId: ctx.user.id, action: "backup.download", entityType: "company", entityId: ctx.company.id, after: { bytes: buf.length, rows: Object.values(b.counts).reduce((a, n) => a + n, 0) } });
  const name = ctx.company.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "business";
  // Streamed in chunks: hosting limits a single non-streamed response to about 4.5 MB, and a year of books can be bigger.
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({ pull(c) { if (i >= buf.length) { c.close(); return; } c.enqueue(new Uint8Array(buf.subarray(i, i + 256 * 1024))); i += 256 * 1024; } });
  return new NextResponse(stream, { headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="Sanskriti-backup_${name}_${todayIST()}.json.gz"` } });
}
