// Reuses the exact SLA thresholds and color language already established in
// src/components/action-center/action-center-hub.tsx (SLA_THRESHOLDS / SlaBadge) — leave and
// excuse have different pending-response windows, so the overdue/approaching cutoff must match.
import { APPROVALS_SLA_THRESHOLDS, slaTone, type ApprovalsSlaModule } from "@/components/approvals-hub/sla-thresholds";

export { APPROVALS_SLA_THRESHOLDS, type ApprovalsSlaModule };

// Compact pill for list cards — mirrors SlaBadge exactly: hidden unless overdue or within 1 day of
// the threshold, so the pending list only calls out what's actually urgent.
export function SlaAgeChip({ ageDays, module }: { ageDays: number; module: ApprovalsSlaModule }) {
  if (ageDays <= 0) return null;
  const threshold = APPROVALS_SLA_THRESHOLDS[module];
  const tone = slaTone(ageDays, threshold);
  const daysLeft = threshold - ageDays;

  if (tone === "overdue") {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-rose-200/80 bg-rose-50 px-1.5 py-0.5 text-phx-2xs font-bold text-rose-700">
        <span className="h-1 w-1 rounded-full bg-rose-500" />
        Overdue {ageDays}d
      </span>
    );
  }
  if (tone === "due") {
    return (
      <span className="whitespace-nowrap rounded-full border border-amber-200/80 bg-amber-50 px-1.5 py-0.5 text-phx-2xs font-bold text-amber-800">
        {daysLeft === 0 ? "Due today" : "1d left"}
      </span>
    );
  }
  return null;
}

// Detail-page age badge — unlike the compact chip, this always shows the waiting-age (useful
// context on the request's own page), but colors it with the same rose/amber/neutral logic.
export function SlaAgeBadge({ ageDays, module }: { ageDays: number; module: ApprovalsSlaModule }) {
  if (ageDays <= 0) return null;
  const threshold = APPROVALS_SLA_THRESHOLDS[module];
  const tone = slaTone(ageDays, threshold);
  const label = `${ageDays} business day${ageDays === 1 ? "" : "s"} waiting`;

  const toneClass =
    tone === "overdue"
      ? "bg-rose-100 text-rose-800"
      : tone === "due"
        ? "bg-amber-100 text-amber-900"
        : "bg-orange-500/90 text-white";

  return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-phx-2xs font-bold ${toneClass}`}>{label}</span>;
}
