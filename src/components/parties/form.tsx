import Link from "next/link";
import { GST_STATES } from "@/lib/gst/states";
import { todayIST, fyStart } from "@/lib/dates";
import { Button, Card, Field, Input, Notice, Select } from "@/components/ui";
import { savePartyAction } from "@/app/actions-phase3";

type P = Partial<Record<string, string | number | null>>;
export function PartyForm({ type, party, sp, companyState }: { type: "CUSTOMER" | "SUPPLIER"; party?: P & { id: string }; sp: Record<string, string | undefined>; companyState?: string | null }) {
  const v = (k: string) => (sp[k] ?? (party?.[k] != null ? String(party[k]) : "")) as string;
  const err = (f: string) => (sp.field === f ? sp.error : undefined);
  const word = type === "CUSTOMER" ? "customer" : "supplier";
  const base = type === "CUSTOMER" ? "/customers" : "/suppliers";
  return <Card>
    {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}
    <form action={savePartyAction} className="grid gap-4 sm:grid-cols-2">
      <input type="hidden" name="type" value={type} />
      {party && <input type="hidden" name="id" value={party.id} />}
      <div className="sm:col-span-2"><Field label={`${type === "CUSTOMER" ? "Customer" : "Supplier"} name`} error={err("name")}><Input name="name" defaultValue={v("name")} required autoFocus={!party} /></Field></div>
      <Field label="Mobile" hint="10 digits" error={err("phone")}><Input name="phone" defaultValue={v("phone")} inputMode="tel" /></Field>
      <Field label="WhatsApp (if different)" error={err("whatsapp")}><Input name="whatsapp" defaultValue={party?.whatsapp !== party?.phone ? v("whatsapp") : sp.whatsapp ?? ""} inputMode="tel" /></Field>
      <Field label="GSTIN (if registered)" hint="State is filled from the GSTIN automatically" error={err("gstin")}><Input name="gstin" defaultValue={v("gstin")} maxLength={15} className="uppercase" /></Field>
      <Field label="State" error={err("stateCode")}><Select name="stateCode" defaultValue={v("stateCode") || companyState || ""}>
        <option value="">—</option>{GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}</Select></Field>
      <Field label="Address"><Input name="addressLine1" defaultValue={v("addressLine1")} /></Field>
      <Field label="City"><Input name="city" defaultValue={v("city")} /></Field>
      <Field label="PIN code" error={err("pincode")}><Input name="pincode" defaultValue={v("pincode")} inputMode="numeric" maxLength={6} /></Field>
      <Field label="Contact person"><Input name="contactPerson" defaultValue={v("contactPerson")} /></Field>
      <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-3">
        <legend className="mb-2 text-[15px] font-semibold">{type === "CUSTOMER" ? "Credit you give" : "Credit they give you"}</legend>
        <Field label="Credit days" hint="Days allowed to pay" error={err("creditDays")}><Input name="creditDays" defaultValue={v("creditDays")} inputMode="numeric" placeholder="30" /></Field>
        {type === "CUSTOMER" && <Field label="Credit limit (₹)" hint="Max amount they can owe" error={err("creditLimit")}><Input name="creditLimit" defaultValue={v("creditLimit")} inputMode="decimal" placeholder="200000" /></Field>}
        {type === "CUSTOMER" && <Field label="Price list"><Select name="priceLevel" defaultValue={v("priceLevel") || "DEALER"}>
          <option value="DEALER">Dealer price</option><option value="WHOLESALE">Wholesale price</option><option value="RETAIL">Retail price</option></Select></Field>}
      </fieldset>
      {!party && <fieldset className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
        <legend className="mb-2 text-[15px] font-semibold">Old balance (optional)</legend>
        <Field label={type === "CUSTOMER" ? "Amount they owe you (₹)" : "Amount you owe them (₹)"} hint="From your register or Tally. If they paid you in advance, enter a minus." error={err("openingBalance")}>
          <Input name="openingBalance" defaultValue={sp.openingBalance} inputMode="decimal" placeholder="0" /></Field>
        <Field label="As on"><Input type="date" name="openingDate" defaultValue={sp.openingDate || fyStart(todayIST())} /></Field>
      </fieldset>}
      <div className="sm:col-span-2"><Field label="Notes"><Input name="notes" defaultValue={v("notes")} /></Field></div>
      <div className="flex gap-3 sm:col-span-2"><Button>Save {word}</Button><Link href={party ? `${base}/${party.id}` : base} className="py-2.5 text-ink-2">Cancel</Link></div>
    </form>
  </Card>;
}
