import { returnableLines } from "@/lib/services/notes";
import { db } from "@/db";
import { formatINR } from "@/lib/money";
import { todayIST } from "@/lib/dates";
import { Button, Card, Field, Input, Notice } from "@/components/ui";

export async function ReturnForm({ kind, docId, action, error, idName }: { kind: "CREDIT_NOTE" | "DEBIT_NOTE"; docId: string; action: (f: FormData) => Promise<void>; error?: string; idName: string }) {
  const lines = await returnableLines(db, kind, docId);
  const any = lines.some((l) => l.left.gt(0));
  return <Card>
    {error && <div className="mb-4"><Notice tone="bad" title={error} /></div>}
    {!any ? <p className="text-ink-2">Everything on this {kind === "CREDIT_NOTE" ? "invoice" : "bill"} has already been returned.</p> :
    <form action={action} className="space-y-4">
      <input type="hidden" name={idName} value={docId} />
      <table className="w-full text-[15px]"><caption className="sr-only">Items</caption>
        <thead className="text-left text-[13px] text-ink-3"><tr><th className="pb-2">Item</th><th className="pb-2 text-right">Rate</th><th className="pb-2 text-right">{kind === "CREDIT_NOTE" ? "Sold" : "Bought"}</th><th className="pb-2 text-right">Already returned</th><th className="w-32 pb-2">Returning now</th></tr></thead>
        <tbody>{lines.map((l) => <tr key={l.id} className="border-t border-line">
          <td className="py-2">{l.name}</td><td className="num text-right">{formatINR(l.rate)}</td><td className="num text-right">{l.qty.toString()} {l.unit}</td><td className="num text-right">{l.returned.toString()}</td>
          <td>{l.left.gt(0) ? <Input name={`ret_${l.id}`} inputMode="decimal" placeholder={`max ${l.left.toString()}`} aria-label={`Quantity returned of ${l.name}`} className="num" /> : <span className="text-ink-3">—</span>}</td></tr>)}</tbody></table>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Date"><Input type="date" name="date" defaultValue={todayIST()} required /></Field>
        <Field label="Reason"><Input name="reason" required placeholder={kind === "CREDIT_NOTE" ? "e.g. 2 batteries faulty" : "e.g. damaged in transit"} /></Field>
      </div>
      <p className="text-[13px] text-ink-3">Priced exactly like the original {kind === "CREDIT_NOTE" ? "invoice" : "bill"} (same rate, discount and GST). {kind === "CREDIT_NOTE" ? "Goods go back into stock; the customer's dues go down." : "Goods leave stock; what you owe goes down."}</p>
      <Button>Save {kind === "CREDIT_NOTE" ? "credit note" : "debit note"}</Button>
    </form>}
  </Card>;
}
