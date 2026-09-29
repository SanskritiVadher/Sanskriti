/**
 * Business health — six parts, each with state, reason (from real figures), trend and action.
 * No single made-up score: each part links to the numbers behind it.
 */
import type { DB } from "@/db";
import { D, formatINRShort } from "@/lib/money";
import { computeRatios, type Ratio, type Status } from "./ratios";
import { stockInsights } from "./stock";
import { ageing } from "@/lib/services/receivables";
import { gstReview, parsePeriod } from "@/lib/services/gst";
import { ledgerHealth } from "@/lib/accounting/reports";
import { todayIST } from "@/lib/dates";

export type Part = { key: string; title: string; question: string; status: Status | "NO_DATA"; state: string; reason: string; trend: string | null; action: string | null; href: string };
const worst = (xs: (Status | null)[]): Status | null => {
  const order: Status[] = ["CRITICAL", "DANGER", "CAUTION", "WATCH", "HEALTHY"];
  for (const o of order) if (xs.includes(o)) return o;
  return null;
};
const trendOf = (r?: Ratio) => {
  if (!r?.value || !r.previous || r.higherIsBetter == null) return null;
  if (r.value.eq(r.previous)) return "No change from the previous period.";
  const better = r.higherIsBetter ? r.value.gt(r.previous) : r.value.lt(r.previous);
  return `${better ? "Better" : "Worse"} than the previous period (${r.unit === "%" ? `${r.previous.toFixed(1)}%` : r.unit === "days" ? `${r.previous.toFixed(0)} days` : r.previous.toFixed(2)} → ${r.unit === "%" ? `${r.value.toFixed(1)}%` : r.unit === "days" ? `${r.value.toFixed(0)} days` : r.value.toFixed(2)}).`;
};

export async function businessHealth(db: DB, companyId: string, from: string, to: string) {
  const today = todayIST();
  const [{ ratios }, stock, rec, checks, review] = await Promise.all([computeRatios(db, companyId, from, to), stockInsights(db, companyId, to),
    ageing(db, companyId, "CUSTOMER", today), ledgerHealth(db, companyId), gstReview(db, companyId, parsePeriod(to.slice(0, 7)))]);
  const R = (k: string) => ratios.find((r) => r.key === k)!;
  const parts: Part[] = [];

  const cur = R("current"), cash = R("cash");
  parts.push({ key: "cash", title: "Cash position", question: "Can I pay what's due soon?", href: "/reports/ratios#current",
    status: worst([cur.status, cash.status]) ?? (cur.value ? "HEALTHY" : "NO_DATA"),
    state: cur.value ? cur.meaning : cur.insufficient ?? "Not enough data.", reason: cur.statusReason || "", trend: trendOf(cur), action: cur.watch });

  const dso = R("dso");
  const overdueShare = rec.total.isZero() ? D(0) : rec.overdue.div(rec.total);
  const recStatus: Status | null = rec.total.isZero() ? null : overdueShare.gt(0.5) ? "DANGER" : overdueShare.gt(0.3) ? "CAUTION" : overdueShare.gt(0.15) ? "WATCH" : "HEALTHY";
  parts.push({ key: "receivables", title: "Money with customers", question: "Are customers paying on time?", href: "/customers",
    status: worst([recStatus, dso.status]) ?? "NO_DATA",
    state: rec.total.isZero() ? "Nobody owes you money right now." : `${formatINRShort(rec.total)} is with customers; ${formatINRShort(rec.overdue)} of it is overdue${rec.buckets.old.gt(0) ? ` (plus ${formatINRShort(rec.buckets.old)} old balance of unknown age)` : ""}.`,
    reason: dso.value ? `${dso.meaning} ${dso.statusReason}` : "", trend: trendOf(dso), action: rec.overdue.gt(0) ? "Start with the 'Call these first' list." : null });

  const gm = R("gross_margin"), nm = R("net_margin");
  parts.push({ key: "profit", title: "Profitability", question: "Am I making money?", href: "/reports/profit",
    status: nm.value?.lt(0) ? "CRITICAL" : worst([gm.status, nm.status]) ?? (nm.value ? "HEALTHY" : "NO_DATA"),
    state: nm.value ? nm.meaning : nm.insufficient ?? "Not enough data.", reason: gm.value ? `${gm.meaning} ${gm.statusReason}` : "", trend: trendOf(nm), action: nm.watch ?? gm.watch });

  const dio = R("dio");
  const slowShare = stock.summary.total.isZero() ? D(0) : stock.summary.slowValue.plus(stock.summary.overValue).div(stock.summary.total);
  const stStatus: Status | null = stock.summary.total.isZero() ? null : stock.summary.counts.OUT > 0 && stock.summary.counts.OUT >= stock.items.length / 4 ? "CAUTION"
    : slowShare.gt(0.4) ? "DANGER" : slowShare.gt(0.25) ? "CAUTION" : slowShare.gt(0.1) || stock.summary.counts.OUT > 0 ? "WATCH" : "HEALTHY";
  parts.push({ key: "stock", title: "Stock", question: "Is my stock working for me?", href: "/inventory/insights",
    status: worst([stStatus, dio.status]) ?? "NO_DATA",
    state: stock.summary.total.isZero() ? "No stock recorded." : `${formatINRShort(stock.summary.total)} in stock; ${formatINRShort(stock.summary.slowValue)} slow or not moving, ${formatINRShort(stock.summary.overValue)} more than needed.`,
    reason: [[stock.summary.counts.OUT && `${stock.summary.counts.OUT} out of stock`, stock.summary.counts.LOW && `${stock.summary.counts.LOW} running low`].filter(Boolean).join(", "), dio.value && dio.meaning].filter(Boolean).join(". "),
    trend: trendOf(dio), action: slowShare.gt(0.1) ? "Clear slow movers before reordering them." : stock.summary.counts.LOW ? "See the reorder list." : null });

  const de = R("de"), icr = R("icr"), dr = R("debt_ratio");
  parts.push({ key: "debt", title: "Borrowing", question: "Am I borrowing too much?", href: "/reports/ratios#de",
    // Loans drive the status. Heavy supplier credit alone is normal for a wholesaler, so it can raise at most a "Watch".
    status: worst([de.status, icr.status, dr.status && dr.status !== "HEALTHY" ? "WATCH" : dr.status]) ?? (dr.value ? "HEALTHY" : "NO_DATA"),
    state: dr.value ? dr.meaning : dr.insufficient ?? "Not enough data.",
    reason: de.value?.isZero() ? "You have no loans recorded — what you owe is supplier credit and other dues." : [de.value && de.meaning, icr.value && icr.meaning].filter(Boolean).join(" "),
    trend: trendOf(dr), action: de.watch ?? icr.watch ?? (dr.status && dr.status !== "HEALTHY" ? "Keep supplier payments on schedule; collect from customers first." : null) });

  const failed = checks.filter((c) => !c.ok);
  parts.push({ key: "hygiene", title: "Books & GST", question: "Are my accounts and GST in order?", href: failed.length ? "/settings/health" : "/gst",
    status: failed.length ? "CRITICAL" : review.length > 3 ? "CAUTION" : review.length ? "WATCH" : "HEALTHY",
    state: failed.length ? `${failed.length} accounting check(s) failed.` : "All accounting checks pass.", reason: review.length ? `${review.length} GST item(s) to review: ${review.slice(0, 2).map((r) => r.what).join(" ")}` : "No GST items to review.",
    trend: null, action: failed.length ? "Open System health." : review.length ? "Open GST → Items requiring review." : null });
  return parts;
}
