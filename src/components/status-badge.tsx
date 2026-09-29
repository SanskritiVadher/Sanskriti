import { Status } from "@/components/ui";
import type { Status as S } from "@/lib/analytics/ratios";

const MAP: Record<S | "NO_DATA", { tone: "good" | "warn" | "bad" | "neutral" | "info"; label: string }> = {
  HEALTHY: { tone: "good", label: "Healthy" }, WATCH: { tone: "info", label: "Watch" }, CAUTION: { tone: "warn", label: "Caution" },
  DANGER: { tone: "bad", label: "Danger" }, CRITICAL: { tone: "bad", label: "Critical" }, NO_DATA: { tone: "neutral", label: "Not enough data" },
};
export function RatioStatus({ s }: { s: S | "NO_DATA" | null }) {
  const m = MAP[s ?? "NO_DATA"];
  return <Status tone={m.tone}>{m.label}</Status>;
}
