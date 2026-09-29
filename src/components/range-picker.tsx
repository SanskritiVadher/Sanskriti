import { todayIST, fyStart } from "@/lib/dates";

const iso = (d: Date) => d.toISOString().slice(0, 10);
export function presets() {
  const t = todayIST(), y = +t.slice(0, 4), m = +t.slice(5, 7);
  const monthStart = `${t.slice(0, 7)}-01`;
  const lastStart = iso(new Date(Date.UTC(y, m - 2, 1))), lastEnd = iso(new Date(Date.UTC(y, m - 1, 0)));
  const qStartMonth = [4, 7, 10, 1][Math.floor(((m + 8) % 12) / 3)];
  const qStart = `${qStartMonth > m ? y - 1 : y}-${String(qStartMonth).padStart(2, "0")}-01`;
  const fy = fyStart(t), lfyStart = `${+fy.slice(0, 4) - 1}-04-01`, lfyEnd = `${fy.slice(0, 4)}-03-31`;
  return [
    { k: "month", l: "This month", from: monthStart, to: t }, { k: "last", l: "Last month", from: lastStart, to: lastEnd },
    { k: "quarter", l: "This quarter", from: qStart, to: t }, { k: "fy", l: "This financial year", from: fy, to: t },
    { k: "lastfy", l: "Last financial year", from: lfyStart, to: lfyEnd },
  ];
}
export function resolveRange(sp: { range?: string; from?: string; to?: string }) {
  const p = presets();
  if (sp.from && sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) && sp.from <= sp.to) return { from: sp.from, to: sp.to, key: "custom" };
  const f = p.find((x) => x.k === sp.range) ?? p[0];
  return { from: f.from, to: f.to, key: f.k };
}
export function RangePicker({ current }: { current: string }) {
  return <form className="flex flex-wrap items-center gap-2">
    {presets().map((p) => <button key={p.k} name="range" value={p.k}
      className={`rounded-full px-3 py-1.5 text-[14px] ${current === p.k ? "bg-brand text-brand-ink" : "border border-line bg-surface text-ink-2"}`}>{p.l}</button>)}
  </form>;
}
