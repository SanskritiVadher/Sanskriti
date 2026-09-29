import { APP_NAME } from "@/lib/brand";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getContext } from "@/lib/session";
import { ROLE_LABEL } from "@/lib/permissions";
import { logoutAction } from "../actions";
import { setViewModeAction } from "../actions-ledger";
import { getViewMode } from "@/lib/view-mode";

const NAV = [
  { href: "/home", label: "Home", phase: 1 },
  { href: "/sell", label: "Sell", phase: 1 },
  { href: "/buy", label: "Buy", phase: 1 },
  { href: "/inventory", label: "Inventory", phase: 1 },
  { href: "/money", label: "Money", phase: 1 },
  { href: "/customers", label: "Customers", phase: 1 },
  { href: "/suppliers", label: "Suppliers", phase: 1 },
  { href: "/gst", label: "GST", phase: 5 },
  { href: "/reports", label: "Reports", phase: 1 },
  { href: "/assistant", label: "AI Assistant", phase: 8 },
  { href: "/settings", label: "Settings", phase: 1 },
];

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getContext();
  if (!ctx) redirect("/login");
  const mode = await getViewMode();
  if (!ctx.company.setupCompletedAt && ctx.role === "OWNER") redirect(`/setup?step=${ctx.company.setupStep}`);
  return <div className="min-h-screen md:flex">
    <aside className="border-b border-line bg-surface md:sticky md:top-0 md:h-screen md:w-60 md:border-r md:border-b-0">
      <div className="px-5 py-5">
        <p className="text-[15px] font-semibold text-brand">{APP_NAME}</p>
        <p className="mt-0.5 truncate text-[13px] text-ink-2">{ctx.company.name}</p>
        {ctx.company.isDemo && <p className="mt-1 text-[12px] font-medium text-warn">⚠ Demo data</p>}
        <form action={setViewModeAction} className="mt-3 flex rounded-lg bg-surface-2 p-0.5 text-[12px]" aria-label="View mode">
          {(["owner", "accountant"] as const).map((m) => <button key={m} name="mode" value={m} aria-pressed={mode === m}
            className={`flex-1 rounded-md px-2 py-1 ${mode === m ? "bg-surface font-semibold text-ink shadow-sm" : "text-ink-2"}`}>
            {m === "owner" ? "Owner view" : "Accountant view"}</button>)}
        </form>
      </div>
      <nav aria-label="Main" className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:overflow-visible">
        {NAV.map((n) => <Link key={n.href} href={n.href}
          className="flex items-center justify-between whitespace-nowrap rounded-lg px-3 py-2 text-[15px] text-ink-2 hover:bg-surface-2 hover:text-ink">
          {n.label}{n.phase > 1 && <span className="ml-2 text-[11px] text-ink-3">soon</span>}</Link>)}
      </nav>
      <div className="hidden px-5 py-4 md:absolute md:bottom-0 md:block md:w-60">
        <p className="text-[14px]">{ctx.user.name}</p>
        <p className="text-[12px] text-ink-3">{ROLE_LABEL[ctx.role]}</p>
        <div className="mt-2 flex gap-3 text-[13px] text-ink-2"><Link className="underline" href="/settings/password">Password</Link>
          <form action={logoutAction}><button className="underline">Log out</button></form></div>
      </div>
    </aside>
    <main className="flex-1 px-4 py-8 md:px-10 md:py-10"><div className="mx-auto max-w-5xl">{children}</div></main>
  </div>;
}
