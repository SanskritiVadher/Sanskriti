import { todayIST } from "@/lib/dates";

/** Last 15 months + last 5 quarters, newest first. */
export function periodOptions() {
  const t = todayIST(); let y = +t.slice(0, 4), m = +t.slice(5, 7);
  const months: { v: string; l: string }[] = [];
  for (let i = 0; i < 15; i++) {
    months.push({ v: `${y}-${String(m).padStart(2, "0")}`, l: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }) });
    if (--m === 0) { m = 12; y--; }
  }
  const fy0 = +t.slice(5, 7) >= 4 ? +t.slice(0, 4) : +t.slice(0, 4) - 1;
  const qs: { v: string; l: string }[] = [];
  for (let fy = fy0; fy >= fy0 - 1; fy--) for (let q = 4; q >= 1; q--) qs.push({ v: `${fy}-Q${q}`, l: `Q${q} of FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")} (${["Apr–Jun", "Jul–Sep", "Oct–Dec", "Jan–Mar"][q - 1]})` });
  return { months, quarters: qs.filter((q) => { const [fy, n] = [+q.v.slice(0, 4), +q.v.slice(-1)]; const start = `${n === 4 ? fy + 1 : fy}-${String([4, 7, 10, 1][n - 1]).padStart(2, "0")}-01`; return start <= t; }).slice(0, 5) };
}

export function PeriodPicker({ value, action = "" }: { value: string; action?: string }) {
  const { months, quarters } = periodOptions();
  return <form action={action} className="flex flex-wrap items-center gap-2">
    <label className="text-[14px] text-ink-2" htmlFor="period">Period</label>
    <select id="period" name="period" defaultValue={value} className="rounded-lg border border-line bg-surface px-3 py-2">
      <optgroup label="Months">{months.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</optgroup>
      <optgroup label="Quarters (QRMP)">{quarters.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</optgroup>
    </select>
    <button className="rounded-lg border border-line bg-surface px-4 py-2">Show</button>
  </form>;
}
