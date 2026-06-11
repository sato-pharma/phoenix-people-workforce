"use client";

import { cn } from "@/lib/utils";

// MoM/YoY delta badge — clone of the Sales Command DeltaBadge semantics:
//   ▲ +X.X%  (emerald)  |  ▼ -X.X%  (rose)  |  —  (slate: baseline missing — a FACT, never invented)
//   ···  pulsing slate  =  the baseline is still LOADING (a state, not a fact).
// `invert` flips the good/bad coloring for metrics where rising is bad (e.g. concentration).
export function SiDeltaBadge({
  pct,
  pending = false,
  surface = "light",
  invert = false,
  label,
  className,
}: {
  /** ratio delta (0.124 = +12.4%); null = no baseline */
  pct: number | null | undefined;
  /** baseline still loading — render a pulsing placeholder, not a dash */
  pending?: boolean;
  surface?: "light" | "dark";
  invert?: boolean;
  /** optional prefix, e.g. "MoM" */
  label?: string;
  className?: string;
}) {
  const prefix = label ? `${label} ` : "";
  if (pending) {
    return (
      <span className={cn("text-xs font-black", surface === "dark" ? "text-slate-500" : "text-slate-400", "animate-pulse", className)}>
        {prefix}···
      </span>
    );
  }
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return (
      <span className={cn("text-xs font-bold", surface === "dark" ? "text-slate-500" : "text-slate-400", className)} title="No baseline month">
        {prefix}—
      </span>
    );
  }
  const up = pct >= 0;
  const good = invert ? !up : up;
  // Muted green/red — professional, not neon (#15803D / #B91C1C on light surfaces).
  const tone = surface === "dark"
    ? good ? "text-emerald-300" : "text-rose-300"
    : good ? "text-[#15803D]" : "text-[#B91C1C]";
  return (
    <span className={cn("text-xs font-black tabular-nums", tone, className)}>
      {prefix}{up ? "▲" : "▼"} {(Math.abs(pct) * 100).toFixed(1)}%
    </span>
  );
}
