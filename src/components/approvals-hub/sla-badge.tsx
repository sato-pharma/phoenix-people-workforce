// Reuses the exact SLA thresholds already established in
// src/components/action-center/action-center-hub.tsx (SLA_THRESHOLDS / SlaBadge) — leave and
// excuse have different pending-response windows, so the overdue/approaching cutoff must match.
import { APPROVALS_SLA_THRESHOLDS, slaTone, type ApprovalsSlaModule, type SlaTone } from "@/components/approvals-hub/sla-thresholds";

export { APPROVALS_SLA_THRESHOLDS, type ApprovalsSlaModule };

// The kit's SLA language (landing-kit.tsx): coloured small capitals and a thin rail, never a filled
// pill — emerald while a request is inside its window, amber the day it falls due, rose once over.
const SLA_TEXT: Record<SlaTone, string> = { none: "text-emerald-700", due: "text-amber-700", overdue: "text-rose-700" };
const SLA_RAIL: Record<SlaTone, string> = { none: "bg-emerald-500", due: "bg-amber-500", overdue: "bg-rose-500" };
const SLA_WORDS = "whitespace-nowrap text-phx-xs font-bold uppercase tracking-[0.1em] tabular-nums";

// Compact mark for list cards — mirrors SlaBadge exactly: hidden unless overdue or within 1 day of
// the threshold, so the pending list only calls out what's actually urgent.
export function SlaAgeChip({ ageDays, module }: { ageDays: number; module: ApprovalsSlaModule }) {
  if (ageDays <= 0) return null;
  const threshold = APPROVALS_SLA_THRESHOLDS[module];
  const tone = slaTone(ageDays, threshold);
  const daysLeft = threshold - ageDays;

  if (tone === "overdue") return <span className={`${SLA_WORDS} ${SLA_TEXT.overdue}`}>Overdue {ageDays}d</span>;
  if (tone === "due") return <span className={`${SLA_WORDS} ${SLA_TEXT.due}`}>{daysLeft === 0 ? "Due today" : "1d left"}</span>;
  return null;
}

// The thin rail under a waiting row, under the same rule as the chip: it appears only once the
// request is due or overdue, and shows how much of its window it has used in that colour.
export function SlaAgeRail({ ageDays, module }: { ageDays: number; module: ApprovalsSlaModule }) {
  if (ageDays <= 0) return null;
  const threshold = APPROVALS_SLA_THRESHOLDS[module];
  const tone = slaTone(ageDays, threshold);
  if (tone === "none") return null;
  const width = Math.max(0, Math.min(100, (ageDays / Math.max(1, threshold)) * 100));
  return (
    <div aria-hidden="true" className="h-0.5 w-full bg-slate-100">
      <div className={`h-full ${SLA_RAIL[tone]}`} style={{ width: `${width}%` }} />
    </div>
  );
}

// Detail-page age badge — unlike the compact chip, this always shows the waiting-age (useful
// context on the request's own page), coloured with the same emerald/amber/rose scale.
export function SlaAgeBadge({ ageDays, module }: { ageDays: number; module: ApprovalsSlaModule }) {
  if (ageDays <= 0) return null;
  const threshold = APPROVALS_SLA_THRESHOLDS[module];
  const tone = slaTone(ageDays, threshold);
  const label = `${ageDays} business day${ageDays === 1 ? "" : "s"} waiting`;

  return <span className={`${SLA_WORDS} ${SLA_TEXT[tone]}`}>{label}</span>;
}
