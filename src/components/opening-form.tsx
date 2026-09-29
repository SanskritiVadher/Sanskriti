import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { currentOpening } from "@/lib/services/vouchers";
import { fyStart, todayIST, fmtDate } from "@/lib/dates";
import { formatINR } from "@/lib/money";
import { Button, Field, Input, Notice } from "./ui";
import { saveOpeningAction } from "@/app/actions-ledger";


/** Opening balances for cash, bank, loans and assets. Stock / customer / supplier openings arrive with Phase 3. */
export async function OpeningForm({ companyId, back }: { companyId: string; back: "setup" | "settings" }) {
  const bankGroup = await db.query.accountGroups.findFirst({ where: and(eq(schema.accountGroups.companyId, companyId), eq(schema.accountGroups.code, "1120")) });
  const accs = await db.query.accounts.findMany({ where: eq(schema.accounts.companyId, companyId), orderBy: schema.accounts.code });
  const banks = accs.filter((a) => a.groupId === bankGroup?.id);
  const byKey = new Map(accs.filter((a) => a.systemKey).map((a) => [a.systemKey!, a]));
  const cur = await currentOpening(db, companyId);
  const date = cur.entry?.entryDate ?? fyStart(todayIST());
  const v = (id: string) => cur.balances[id] ?? "";

  const Row = ({ id, label, hint }: { id: string; label: string; hint?: string }) =>
    <Field label={label} hint={hint}><Input name={`bal_${id}`} defaultValue={v(id)} inputMode="decimal" placeholder="0" className="num" /></Field>;

  return <form action={saveOpeningAction} className="space-y-6">
    <input type="hidden" name="back" value={back} />
    {cur.entry && <Notice tone="info" title={`Opening balances already recorded as on ${fmtDate(cur.entry.entryDate)} (total ${formatINR(cur.entry.totalAmount)}).`}>
      Saving again replaces them. The old entry is cancelled, not deleted.</Notice>}
    <Field label="Balances as on" hint="Usually the first day of the financial year (1 April) or the day you start using this app.">
      <Input type="date" name="date" defaultValue={date} required /></Field>
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-[15px] font-semibold">Money you have</legend>
      <Row id={byKey.get("CASH")!.id} label="Cash in hand (₹)" />
      {banks.map((b) => <Row key={b.id} id={b.id} label={`${b.ownerLabel} (₹)`} hint="If overdrawn, enter a minus, e.g. -25000" />)}
    </fieldset>
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-[15px] font-semibold">Other things the business owns / owes</legend>
      <Row id={byKey.get("FIXED_FURNITURE")!.id} label="Furniture & equipment (₹)" />
      <Row id={byKey.get("FIXED_VEHICLES")!.id} label="Vehicles (₹)" />
      <Row id={byKey.get("SUPPLIER_ADVANCES")!.id} label="Advances paid to suppliers (₹)" />
      <Row id={byKey.get("BANK_LOAN")!.id} label="Loan outstanding (₹)" hint="Amount still to repay" />
      <Row id={byKey.get("CAPITAL")!.id} label="Owner's capital (₹) — optional" hint="Leave empty if unsure. The difference is recorded automatically." />
    </fieldset>
    <Notice tone="info" title="Stock, customer dues and supplier dues come next.">
      These need your product, customer and supplier lists, which arrive in Phase 3.</Notice>
    <p className="text-[13px] text-ink-3">How this balances: whatever the business owns minus what it owes is recorded as the owner&rsquo;s opening stake
      (&ldquo;Opening balances (setup)&rdquo;). Your accountant can move it to capital later.</p>
    <Button>Save opening balances</Button>
  </form>;
}
