import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import type { PreviewRow } from "@/lib/services/importer";
import { fyStart, todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, PageHeader, Status } from "@/components/ui";
import { confirmImportAction, discardImportAction } from "@/app/actions-phase3";

const LABEL: Record<string, string> = { name: "Name", phone: "Phone", gstin: "GSTIN", state: "State", city: "City", opening: "Old balance",
  sku: "Code", brand: "Brand", hsn: "HSN", gstRate: "GST %", openingQty: "Qty", openingRate: "Cost each", dealerPrice: "Dealer price", purchasePrice: "Purchase price" };

export default async function Preview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireContext();
  const { id } = await params;
  const sp = await searchParams;
  const b = await db.query.importBatches.findFirst({ where: and(eq(schema.importBatches.id, id), eq(schema.importBatches.companyId, ctx.company.id)) });
  if (!b) notFound();
  const rows = b.rows as PreviewRow[];
  const sum = b.summary as { ok: number; skip: number; error: number; columns: string[] };
  const cols = sum.columns.filter((c) => LABEL[c]).slice(0, 7);
  const hasOpening = sum.columns.some((c) => c === "opening" || c === "openingQty");

  return <>
    <PageHeader title="Check before importing" subtitle={`${b.fileName} · ${b.kind}`} />
    {sp.error && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    {b.status !== "PREVIEW" && <div className="mb-4"><Notice tone="info" title={`This import was ${b.status.toLowerCase()}.`} /></div>}
    <Card className="mb-6">
      <div className="flex flex-wrap gap-3"><Status tone="good">{sum.ok} ready</Status><Status tone="neutral">{sum.skip} will be skipped</Status>
        {sum.error > 0 && <Status tone="bad">{sum.error} have problems</Status>}</div>
      <p className="mt-3 text-[14px] text-ink-2">Columns found: {sum.columns.map((c) => LABEL[c] ?? c).join(", ")}.
        {sum.error > 0 && " Rows with problems won't be imported. Fix them in the file and upload again, or import the rest now."}</p>
      {b.status === "PREVIEW" && sum.ok > 0 && <form action={confirmImportAction} className="mt-5 flex flex-wrap items-end gap-3">
        <input type="hidden" name="batchId" value={b.id} />
        {hasOpening && <Field label="Balances / stock are as on" hint="Usually 1 April, or the date of the Tally report"><Input type="date" name="openingDate" defaultValue={fyStart(todayIST())} required /></Field>}
        {!hasOpening && <input type="hidden" name="openingDate" value={todayIST()} />}
        <Button>Import {sum.ok} {b.kind}</Button>
      </form>}
      {b.status === "PREVIEW" && <form action={discardImportAction} className="mt-3"><input type="hidden" name="batchId" value={b.id} /><input type="hidden" name="kind" value={b.kind} />
        <button className="text-[14px] text-ink-2 underline">Discard this upload</button></form>}
    </Card>
    <Card className="overflow-x-auto">
      <table className="w-full text-[14px]"><caption className="sr-only">Rows</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Row</th><th className="pb-2">Status</th>{cols.map((c) => <th key={c} className="pb-2">{LABEL[c]}</th>)}<th className="pb-2">Note</th></tr></thead>
        <tbody>{[...rows].sort((a, z) => ({ error: 0, ok: 1, skip: 2 }[a.status] - { error: 0, ok: 1, skip: 2 }[z.status])).map((r) =>
          <tr key={r.rowNo} className="border-t border-line align-top">
            <td className="num py-2 text-ink-3">{r.rowNo}</td>
            <td>{r.status === "ok" ? <Status tone="good">Ready</Status> : r.status === "skip" ? <Status tone="neutral">Skip</Status> : <Status tone="bad">Problem</Status>}</td>
            {cols.map((c) => <td key={c} className="pr-2">{r.data[c]}</td>)}
            <td className={r.status === "error" ? "text-bad" : "text-ink-2"}>{r.message}</td></tr>)}</tbody>
      </table>
    </Card>
  </>;
}
