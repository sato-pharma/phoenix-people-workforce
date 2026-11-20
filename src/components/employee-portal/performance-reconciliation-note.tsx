import { cn } from "@/lib/utils";

/**
 * The one-line reconciliation note shown under a performance snapshot / leaderboard.
 *
 * The performance surfaces (NSM DSMs & Med Reps, CEO company roll-ups) show a HEADLINE
 * total that covers every scoped Source-of-Sales row, but the leaderboard beneath only
 * lists rows the engine could attribute to a seated rep or DM. Direct Orders spread
 * across regions and sales sitting on vacant seats therefore live in the header but in no
 * visible row — up to ~39% of a line's July 2026 actual. Without this note the header
 * simply does not foot to the rows and reads as broken.
 *
 * `unattributedSales` is `headline − Σ(shown members)`, so header = leaderboard + this.
 * Renders nothing when the gap is zero or negative (a fully-attributed scope needs no
 * explanation).
 *
 * Drawn in the landing language (owner, 2026-11-20 redesign): no filled box and no icon — a 2px
 * rule on the left and the sentence beside it, the amount in the page's figure ink. `onNavy` sets
 * it for the night-navy headline board, where the Regional Manager's region figures sit.
 */
export function PerformanceReconciliationNote({
  unattributedSales,
  totalLabel,
  className,
  onNavy = false,
}: {
  unattributedSales: number;
  /** What the headline is called on this page, e.g. "Line Sales" / "Company Sales". */
  totalLabel: string;
  className?: string;
  /** On a landing's night-navy headline board rather than a white page. */
  onNavy?: boolean;
}) {
  if (!(unattributedSales > 0.5)) return null;

  const amount = new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(unattributedSales);

  return (
    <p
      className={cn(
        "min-w-0 break-words border-l-2 py-1 pl-3 text-phx-xs leading-relaxed",
        onNavy ? "border-white/25 text-white/60" : "border-slate-300 text-slate-600",
        className,
      )}
    >
      <span className={cn("font-bold tabular-nums", onNavy ? "text-white" : "text-[#08111f]")}>{amount}</span> of{" "}
      {totalLabel} is Direct Orders and vacant seats not attributed to anyone listed below — so {totalLabel} equals the
      leaderboard total plus this amount.
    </p>
  );
}
