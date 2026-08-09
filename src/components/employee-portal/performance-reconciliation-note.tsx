import { Info } from "lucide-react";

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
 */
export function PerformanceReconciliationNote({
  unattributedSales,
  totalLabel,
  className,
}: {
  unattributedSales: number;
  /** What the headline is called on this page, e.g. "Line Sales" / "Company Sales". */
  totalLabel: string;
  className?: string;
}) {
  if (!(unattributedSales > 0.5)) return null;

  const amount = new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(unattributedSales);

  return (
    <div
      className={`flex items-start gap-2.5 border border-slate-200 border-l-2 border-l-slate-400 bg-slate-50 px-3.5 py-2.5 ${className ?? ""}`}
    >
      <Info aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
      <p className="text-[11px] font-medium leading-relaxed text-slate-600">
        <span className="font-bold text-slate-800">{amount}</span> of {totalLabel} is Direct Orders and
        vacant seats not attributed to anyone listed below — so {totalLabel} equals the leaderboard total
        plus this amount.
      </p>
    </div>
  );
}
