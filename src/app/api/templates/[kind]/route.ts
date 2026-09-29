import { NextResponse } from "next/server";
import { TEMPLATES, type ImportKind } from "@/lib/services/importer";

export async function GET(_: Request, { params }: { params: Promise<{ kind: string }> }) {
  const kind = (await params).kind as ImportKind;
  if (!TEMPLATES[kind]) return NextResponse.json({ error: "unknown" }, { status: 404 });
  return new NextResponse("﻿" + TEMPLATES[kind], { headers: {
    "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${kind}-template.csv"` } });
}
