// Shared DV Planner coverage summary. Client-safe on purpose: it imports ONLY the roster type,
// never service.ts / supabase — so both the portal scorecard (F2) and the weekly digest (F4) can
// reduce the same roster into the same headline numbers, guaranteeing the email matches the page.

import type { DoubleVisitRosterEntry } from "@/lib/double-visit-analytics/types";

export type DvCoverageSummary = {
  /** Every active Medical Rep in the group/scope. */
  total: number;
  /** Reps double-visited within the selected window. */
  covered: number;
  /** covered / total, 0–100, rounded; 0 when total is 0. */
  coveragePct: number;
  /** Reps not double-visited within the selected window. */
  neverVisited: number;
  /** Reps whose cadence band is warning or critical (stale vs the 30/60-day thresholds). */
  overdue: number;
  /** Reps currently on probation. */
  onProbation: number;
  /** Probationers whose required DV (for the viewer's role) is not yet done. */
  probationDvPending: number;
};

export function summarizeRosterCoverage(entries: readonly DoubleVisitRosterEntry[]): DvCoverageSummary {
  const total = entries.length;
  let covered = 0;
  let neverVisited = 0;
  let overdue = 0;
  let onProbation = 0;
  let probationDvPending = 0;

  for (const entry of entries) {
    if (entry.visited) covered += 1;
    else neverVisited += 1;
    if (entry.cadenceOverdue) overdue += 1;
    if (entry.onProbation) {
      onProbation += 1;
      if (entry.probationDvDone === false) probationDvPending += 1;
    }
  }

  return {
    total,
    covered,
    coveragePct: total > 0 ? Math.round((covered / total) * 100) : 0,
    neverVisited,
    overdue,
    onProbation,
    probationDvPending,
  };
}
