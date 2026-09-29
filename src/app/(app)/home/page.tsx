import Link from "next/link";
import { eq, and, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireContext } from "@/lib/session";
import { stateByCode } from "@/lib/gst/states";
import { Card, Notice, PageHeader, Status } from "@/components/ui";
import { moneyPosition } from "@/lib/accounting/reports";
import { partyBalances } from "@/lib/services/parties";
import { stockList } from "@/lib/services/inventory";
import { D } from "@/lib/money";
import { formatINRShort } from "@/lib/money";
import { todayIST } from "@/lib/dates";

function greeting() {
  const h = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export default async function Home({ searchParams }: { searchParams: Promise<{ welcome?: string; denied?: string }> }) {
  const ctx = await requireContext("view.dashboard");
  const sp = await searchParams;
  const c = ctx.company;
  const [banks, brands, accounts] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(schema.bankAccounts).where(eq(schema.bankAccounts.companyId, c.id)),
    db.query.brands.findMany({ where: eq(schema.brands.companyId, c.id) }),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.accounts).where(and(eq(schema.accounts.companyId, c.id))),
  ]);

  const money = await moneyPosition(db, c.id, todayIST());
  const [{ n: entryCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.journalEntries).where(eq(schema.journalEntries.companyId, c.id));
  const [custBal, supBal, stock] = await Promise.all([partyBalances(db, c.id, "CUSTOMER"), partyBalances(db, c.id, "SUPPLIER"), stockList(db, c.id)]);
  const toCollect = [...custBal.values()].filter((b) => b.balance.gt(0));
  const collectTotal = toCollect.reduce((s, b) => s.plus(b.balance), D(0));
  const toPay = [...supBal.values()].filter((b) => b.balance.gt(0)).reduce((s, b) => s.plus(b.balance), D(0));
  const stockValue = stock.filter((r) => r.isActive).reduce((s, r) => s.plus(r.value), D(0));
  const lowCount = stock.filter((r) => r.isActive && (r.status === "LOW" || r.status === "OUT")).length;
  const tiles = [
    { label: "Cash and bank", value: money.total, note: "Money you can use today", href: "/money" },
    { label: "Customers owe you", value: collectTotal, note: toCollect.length ? `${toCollect.length} customer${toCollect.length === 1 ? "" : "s"}` : "Nothing due", href: "/customers" },
    { label: "You owe suppliers", value: toPay, note: toPay.gt(0) ? "Due to suppliers" : "Nothing due", href: "/suppliers" },
    { label: "Stock value", value: stockValue, note: lowCount ? `${lowCount} item${lowCount === 1 ? "" : "s"} low or out` : stock.length ? "No items running low" : "No products yet", href: "/inventory", warn: lowCount > 0 },
  ];
  const checks = [
    { label: "Business details", done: !!(c.addressLine1 && c.stateCode), href: "/setup?step=1" },
    { label: c.gstRegistration === "UNREGISTERED" ? "GST: not registered" : "GST number", done: c.gstRegistration === "UNREGISTERED" || !!c.gstin, href: "/setup?step=2" },
    { label: "Bank account", done: banks[0].n > 0, href: "/setup?step=3" },
    { label: "Brands", done: brands.length > 0, href: "/setup?step=4" },
    { label: "Opening balances", done: !!c.booksBeginOn, href: "/settings/opening" },
    { label: "Products", done: stock.length > 0, href: "/inventory" },
    { label: "Customers", done: custBal.size > 0 || (await db.select({ n: sql<number>`count(*)::int` }).from(schema.parties).where(and(eq(schema.parties.companyId, c.id), eq(schema.parties.type, "CUSTOMER"))))[0].n > 0, href: "/customers" },
  ];

  return <>
    <PageHeader title={`${greeting()}, ${ctx.user.name.split(" ")[0]}`} subtitle="Here's where things stand." />
    {sp.denied && <div className="mb-6"><Notice tone="warn" title="You don't have access to that page.">Ask the owner to change your role if you need it.</Notice></div>}
    {sp.welcome && <div className="mb-6"><Notice tone="good" title="Setup saved.">Your books are ready for the next steps.</Notice></div>}

    <Card className="mb-6">
      <h2 className="text-[18px] font-semibold">Your business pulse</h2>
      {entryCount > 0 && <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{tiles.map((t) =>
        <Link key={t.label} href={t.href} className="rounded-xl bg-surface-2 px-4 py-3 hover:ring-1 hover:ring-brand">
          <p className="text-[13px] text-ink-2">{t.label}</p>
          <p className="num text-[24px] font-semibold">{formatINRShort(t.value)}</p>
          <p className={`text-[13px] ${t.warn ? "text-warn" : "text-ink-3"}`}>{t.warn ? "⚠ " : ""}{t.note}</p></Link>)}</div>}
      <p className="mt-4 text-ink-2">Sales and purchases aren&rsquo;t recorded yet (billing arrives in Phase 4), so there&rsquo;s no profit or sales trend to explain yet.
        Once billing is live, this space will tell you how sales, profit, cash, dues and stock are moving, and why.</p>
      <p className="mt-3 text-[13px] text-ink-3">We never show made-up numbers here. Every figure will come from your own records.</p>
    </Card>

    <div className="grid gap-6 md:grid-cols-2">
      <Card>
        <h2 className="text-[18px] font-semibold">Setup checklist</h2>
        <ul className="mt-4 space-y-2">{checks.map((k) =>
          <li key={k.label} className="flex items-center justify-between rounded-lg bg-surface-2 px-4 py-3">
            <span>{k.label}</span>{k.done ? <Status tone="good">Done</Status> : <Link href={k.href}><Status tone="warn">To do</Status></Link>}</li>)}
        </ul>
      </Card>
      <Card>
        <h2 className="text-[18px] font-semibold">Your books</h2>
        <dl className="mt-4 space-y-3 text-[15px]">
          <div className="flex justify-between"><dt className="text-ink-2">State</dt><dd>{stateByCode(c.stateCode)?.name ?? "Not set"}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">GSTIN</dt><dd className="num">{c.gstin ?? "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">Brands</dt><dd>{brands.map((b) => b.name).join(", ") || "—"}</dd></div>
          <div className="flex justify-between"><dt className="text-ink-2">Accounts ready</dt><dd><Link className="underline" href="/settings/accounts">{accounts[0].n} ledgers</Link></dd></div>
        </dl>
      </Card>
    </div>
  </>;
}
