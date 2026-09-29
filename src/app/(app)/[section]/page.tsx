import { notFound } from "next/navigation";
import { requireContext } from "@/lib/session";
import { Card, Notice, PageHeader } from "@/components/ui";

const SECTIONS: Record<string, { title: string; q: string; phase: number; what: string }> = {
  sell: { title: "Sell", q: "Create bills fast", phase: 4, what: "Fast wholesale billing with automatic GST, credit-limit and margin checks." },
  buy: { title: "Buy", q: "Record purchases", phase: 4, what: "Purchase orders, purchase bills, returns and supplier price history." },
  gst: { title: "GST", q: "Is my GST in order?", phase: 5, what: "Your GST position, input vs output, and items needing review." },
  assistant: { title: "AI Assistant", q: "Ask anything about your business", phase: 8, what: "Answers grounded only in your own records. It will never post entries without your approval." },
};

export default async function Section({ params }: { params: Promise<{ section: string }> }) {
  await requireContext();
  const s = SECTIONS[(await params).section];
  if (!s) notFound();
  return <>
    <PageHeader title={s.title} subtitle={s.q} />
    <Card><Notice tone="info" title={`Coming in Phase ${s.phase}`}>{s.what}</Notice>
      <p className="mt-4 text-[14px] text-ink-3">This page is intentionally empty until it works for real — no sample numbers are shown.</p></Card>
  </>;
}
