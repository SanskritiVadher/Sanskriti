import { APP_NAME } from "@/lib/brand";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { GST_STATES, stateByCode } from "@/lib/gst/states";
import { Button, Card, Field, Input, Notice, Select, Status } from "@/components/ui";
import { OpeningForm } from "@/components/opening-form";
import { saveBusinessAction, saveGstAction, addBankAction, addBrandAction, goToStepAction } from "../actions";

const STEPS = ["Business", "GST", "Bank accounts", "Brands", "Customers", "Suppliers", "Opening balances", "Ready"];

export default async function Setup({ searchParams }: { searchParams: Promise<{ step?: string; error?: string; field?: string; gstin?: string }> }) {
  const ctx = await requireContext("company.edit");
  const sp = await searchParams;
  const step = Math.min(8, Math.max(1, Number(sp.step) || ctx.company.setupStep));
  const c = ctx.company;
  const err = (f: string) => (sp.field === f ? sp.error : undefined);

  return <main className="mx-auto max-w-3xl px-4 py-10">
    <p className="text-[15px] font-semibold text-brand">{APP_NAME} · Setting up {c.name}</p>
    <ol className="mt-6 mb-8 flex flex-wrap gap-2" aria-label="Setup steps">
      {STEPS.map((s, i) => <li key={s}>
        <Link href={`/setup?step=${i + 1}`} aria-current={step === i + 1 ? "step" : undefined}
          className={`rounded-full px-3 py-1 text-[13px] ${step === i + 1 ? "bg-brand text-brand-ink" : i + 1 < c.setupStep && !(i >= 4 && i <= 5) ? "bg-good-bg text-good" : "bg-surface-2 text-ink-2"}`}>
          {i + 1 < c.setupStep && step !== i + 1 ? (i >= 4 && i <= 5 ? "– " : "✓ ") : `${i + 1}. `}{s}</Link></li>)}
    </ol>
    {sp.error && !sp.field && <div className="mb-4"><Notice tone="bad" title={sp.error} /></div>}

    {step === 1 && <Card>
      <h2 className="text-[22px] font-semibold">About your business</h2>
      <p className="mb-6 text-ink-2">This appears on your invoices.</p>
      <form action={saveBusinessAction} className="grid gap-4 sm:grid-cols-2">
        <input type="hidden" name="next" value="setup" />
        <div className="sm:col-span-2"><Field label="Business name" error={err("name")}><Input name="name" defaultValue={c.name} required /></Field></div>
        <Field label="Legal name (if different)"><Input name="legalName" defaultValue={c.legalName ?? ""} /></Field>
        <Field label="Phone"><Input name="phone" defaultValue={c.phone ?? ""} inputMode="tel" /></Field>
        <div className="sm:col-span-2"><Field label="Address"><Input name="addressLine1" defaultValue={c.addressLine1 ?? ""} /></Field></div>
        <div className="sm:col-span-2"><Field label="Address line 2 (optional)"><Input name="addressLine2" defaultValue={c.addressLine2 ?? ""} /></Field></div>
        <Field label="City"><Input name="city" defaultValue={c.city ?? ""} /></Field>
        <Field label="PIN code" error={err("pincode")}><Input name="pincode" defaultValue={c.pincode ?? ""} inputMode="numeric" maxLength={6} /></Field>
        <Field label="State" hint="Decides whether GST is CGST+SGST or IGST" error={err("stateCode")}>
          <Select name="stateCode" defaultValue={c.stateCode ?? ""} required>
            <option value="" disabled>Choose state</option>
            {GST_STATES.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </Select></Field>
        <Field label="Email (optional)"><Input name="email" type="email" defaultValue={c.email ?? ""} /></Field>
        <div className="sm:col-span-2 flex justify-end"><Button>Save and continue</Button></div>
      </form>
    </Card>}

    {step === 2 && <Card>
      <h2 className="text-[22px] font-semibold">GST registration</h2>
      <p className="mb-6 text-ink-2">We use this to work out GST on every bill automatically.</p>
      <form action={saveGstAction} className="space-y-4">
        <input type="hidden" name="next" value="setup" />
        <Field label="Are you registered under GST?">
          <Select name="registration" defaultValue={c.gstRegistration}>
            <option value="REGULAR">Yes – regular registration</option>
            <option value="COMPOSITION">Yes – composition scheme</option>
            <option value="UNREGISTERED">No, not registered</option>
          </Select></Field>
        <Field label="GSTIN" hint="15 characters, e.g. 08ABCDE1234F1Z5. Leave empty if not registered." error={err("gstin")}>
          <Input name="gstin" defaultValue={sp.gstin ?? c.gstin ?? ""} maxLength={15} className="uppercase" autoCapitalize="characters" /></Field>
        {c.gstin && !sp.error && <Notice tone="good" title={`GSTIN format is valid · ${stateByCode(c.stateCode)?.name ?? ""}`}>
          We checked the format and check-digit offline. We have not confirmed it is active on the GST portal — live verification is not connected yet.</Notice>}
        {c.gstRegistration === "COMPOSITION" && <Notice tone="warn" title="Composition scheme">
          Composition dealers cannot charge GST on invoices or claim input GST. Billing will follow this in Phase 5. Please confirm with your CA.</Notice>}
        <div className="flex justify-between"><Link href="/setup?step=1" className="py-2.5 text-ink-2">← Back</Link><Button>Save and continue</Button></div>
      </form>
    </Card>}

    {step === 3 && <BankStep companyId={c.id} err={err} />}
    {step === 4 && <BrandStep companyId={c.id} err={err} />}

    {step === 7 && <Card>
      <h2 className="text-[22px] font-semibold">Opening balances</h2>
      <p className="mb-6 text-ink-2">How much cash and bank balance the business has today. You can change this later in Settings.</p>
      <OpeningForm companyId={c.id} back="setup" />
      <form action={goToStepAction} className="mt-6 flex justify-between border-t border-line pt-6">
        <Link href="/setup?step=6" className="py-2.5 text-ink-2">← Back</Link>
        <input type="hidden" name="step" value="8" /><Button variant="secondary">Skip for now</Button></form>
    </Card>}

    {(step === 5 || step === 6) && <Card>
      <h2 className="text-[22px] font-semibold">{STEPS[step - 1]}</h2>
      <div className="my-6"><Notice tone="info" title="Not built yet">
        {step === 5 && "Adding customers arrives in the next update (Phase 3). You'll be able to add them one by one or import from Excel."}
        {step === 6 && "Adding suppliers arrives in the next update (Phase 3)."}
      </Notice></div>
      <form action={goToStepAction} className="flex justify-between">
        <Link href={`/setup?step=${step - 1}`} className="py-2.5 text-ink-2">← Back</Link>
        <input type="hidden" name="step" value={step + 1} /><Button variant="secondary">Skip for now</Button>
      </form>
    </Card>}

    {step === 8 && <Card>
      <h2 className="text-[22px] font-semibold">You&rsquo;re set up</h2>
      <p className="mt-2 mb-6 text-ink-2">Your accounts, GST ledgers and main godown are ready. You can record money in and out now; buying and selling switch on as each part is built.</p>
      <form action={goToStepAction}><input type="hidden" name="step" value="8" /><input type="hidden" name="finish" value="1" />
        <Button>Go to my dashboard</Button></form>
    </Card>}
  </main>;
}

async function BankStep({ companyId, err }: { companyId: string; err: (f: string) => string | undefined }) {
  const banks = await db.query.bankAccounts.findMany({ where: eq(schema.bankAccounts.companyId, companyId) });
  return <Card>
    <h2 className="text-[22px] font-semibold">Bank accounts</h2>
    <p className="mb-6 text-ink-2">A cash account is already created. Add the bank accounts your business uses.</p>
    <ul className="mb-6 space-y-2">
      <li className="flex items-center justify-between rounded-lg bg-surface-2 px-4 py-3"><span>Cash in hand</span><Status tone="good">Ready</Status></li>
      {banks.map((b) => <li key={b.id} className="flex items-center justify-between rounded-lg bg-surface-2 px-4 py-3">
        <span>{b.bankName}{b.accountNumberLast4 && ` ••${b.accountNumberLast4}`}{b.ifsc && <span className="ml-2 text-ink-3">{b.ifsc}</span>}</span>
        <Status tone="good">Added</Status></li>)}
    </ul>
    <form action={addBankAction} className="grid gap-4 sm:grid-cols-2">
      <Field label="Bank name" error={err("bankName")}><Input name="bankName" placeholder="e.g. State Bank of India" required /></Field>
      <Field label="Account holder name"><Input name="accountHolder" /></Field>
      <Field label="Account number" hint="We only store the last 4 digits."><Input name="accountNumber" inputMode="numeric" autoComplete="off" /></Field>
      <Field label="IFSC" error={err("ifsc")}><Input name="ifsc" maxLength={11} className="uppercase" /></Field>
      <div className="sm:col-span-2"><Button variant="secondary">+ Add this bank account</Button></div>
    </form>
    <form action={goToStepAction} className="mt-8 flex justify-between border-t border-line pt-6">
      <Link href="/setup?step=2" className="py-2.5 text-ink-2">← Back</Link>
      <input type="hidden" name="step" value="4" /><Button>Continue</Button></form>
  </Card>;
}

async function BrandStep({ companyId, err }: { companyId: string; err: (f: string) => string | undefined }) {
  const list = await db.query.brands.findMany({ where: eq(schema.brands.companyId, companyId) });
  const have = new Set(list.map((b) => b.name.toLowerCase()));
  const suggested = ["SF Sonic", "Usha"].filter((n) => !have.has(n.toLowerCase()));
  return <Card>
    <h2 className="text-[22px] font-semibold">Which brands do you sell?</h2>
    <p className="mb-6 text-ink-2">You can add more any time. Products come in the next update.</p>
    {list.length > 0 && <ul className="mb-4 flex flex-wrap gap-2">{list.map((b) => <li key={b.id}><Status tone="good">{b.name}</Status></li>)}</ul>}
    {suggested.length > 0 && <div className="mb-6 flex flex-wrap gap-2">{suggested.map((n) =>
      <form key={n} action={addBrandAction}><input type="hidden" name="name" value={n} /><Button variant="secondary">+ {n}</Button></form>)}</div>}
    <form action={addBrandAction} className="flex gap-2">
      <div className="flex-1"><Field label="Other brand" error={err("name")}><Input name="name" placeholder="Brand name" /></Field></div>
      <Button variant="secondary" className="self-end">Add</Button>
    </form>
    <form action={goToStepAction} className="mt-8 flex justify-between border-t border-line pt-6">
      <Link href="/setup?step=3" className="py-2.5 text-ink-2">← Back</Link>
      <input type="hidden" name="step" value="5" /><Button>Continue</Button></form>
  </Card>;
}
