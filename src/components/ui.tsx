import Link from "next/link";
import type { ReactNode, InputHTMLAttributes, SelectHTMLAttributes, ButtonHTMLAttributes } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  return <button {...p} className={cx(
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[15px] font-medium transition-colors disabled:opacity-50",
    variant === "primary" && "bg-brand text-brand-ink hover:opacity-90",
    variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
    variant === "ghost" && "text-ink-2 hover:bg-surface-2",
    className)} />;
}

export function LinkButton({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" | "ghost" }) {
  return <Link href={href} className={cx(
    "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-[15px] font-medium",
    variant === "primary" && "bg-brand text-brand-ink hover:opacity-90",
    variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
    variant === "ghost" && "text-ink-2 hover:bg-surface-2")}>{children}</Link>;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-2xl border border-line bg-surface p-6", className)}>{children}</section>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[14px] font-medium text-ink">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-[13px] text-ink-3">{hint}</span>}
      {error && <span role="alert" className="mt-1 block text-[13px] text-bad">⚠ {error}</span>}
    </label>
  );
}

const inputCls = "w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-[15px] text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, p.className)} />;

type Tone = "good" | "warn" | "bad" | "info" | "neutral";
const TONE: Record<Tone, { cls: string; icon: string }> = {
  good: { cls: "bg-good-bg text-good", icon: "✓" },
  warn: { cls: "bg-warn-bg text-warn", icon: "⚠" },
  bad: { cls: "bg-bad-bg text-bad", icon: "✕" },
  info: { cls: "bg-info-bg text-info", icon: "i" },
  neutral: { cls: "bg-surface-2 text-ink-2", icon: "•" },
};

/** Status is never colour alone: icon + text always accompany it. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[13px] font-medium", t.cls)}>
    <span aria-hidden>{t.icon}</span>{children}</span>;
}

export function Notice({ tone = "info", title, children }: { tone?: Tone; title?: string; children?: ReactNode }) {
  const t = TONE[tone];
  return <div role={tone === "bad" ? "alert" : "status"} className={cx("flex gap-3 rounded-xl px-4 py-3 text-[14px]", t.cls)}>
    <span aria-hidden className="font-bold">{t.icon}</span>
    <div>{title && <p className="font-semibold">{title}</p>}{children && <div className="opacity-90">{children}</div>}</div>
  </div>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
    <div><h1 className="text-[28px] font-semibold tracking-tight">{title}</h1>
      {subtitle && <p className="mt-1 text-[16px] text-ink-2">{subtitle}</p>}</div>
    {action}
  </div>;
}
