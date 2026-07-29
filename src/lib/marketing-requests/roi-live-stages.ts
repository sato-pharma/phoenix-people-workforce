// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle + timing rules for the LIVE (Phoenix-submitted) ROI Tracker.
//
// This lives in src/lib rather than inside the component for two reasons: the repo's domain-first
// rule (business rules belong to the domain, components render them), and because these two small
// functions decide which bucket every committed EGP is counted in — that is exactly the kind of
// rule that deserves tests rather than a visual check.
//
// It deliberately derives everything from fields already present on the report row. It performs no
// queries and no attribution: like the rest of the tracker, it is a reading of the authoritative
// engine's output, never a second opinion about it.
// ─────────────────────────────────────────────────────────────────────────────

import type { RoiTrackerRow } from "@/lib/marketing-requests/roi-tracker-service";

/**
 * Where a request sits in its life. STAGES, not verdicts — how a campaign performed lives in
 * `resultStatus`; this answers only "where is the money right now".
 */
export type RoiLifecycleStage = "rejected" | "awaiting_approval" | "approved_unpaid" | "measuring" | "judged";

/** Statuses that mean nobody has committed the money yet — a decision is still outstanding. */
const AWAITING_STATUSES = new Set(["draft", "pending_validation", "pending_approval", "returned", "finance_hold"]);

/**
 * Order is load-bearing:
 *
 * 1. `rejected` is checked FIRST so turned-down money can never be counted as committed. Production
 *    carries rejected requests that still have a pay date (10 of them, one dated in the future), so
 *    testing the pay date before the status would silently promote refused spend into the pipeline.
 * 2. A request with no pay date, or one dated beyond the validated-data frontier, has not started
 *    its ROI clock — it is approved money that has not gone out yet, not money being measured.
 * 3. Only once the window is fully covered by validated sales (`dataCoverage === "complete"`) is a
 *    request judgeable. Everything else in flight is still measuring.
 */
export function roiLifecycleStage(row: RoiTrackerRow, dataFrontier: string | null): RoiLifecycleStage {
  if (row.status === "rejected") return "rejected";
  if (AWAITING_STATUSES.has(row.status)) return "awaiting_approval";
  if (!row.payDate || (dataFrontier && row.payDate.slice(0, 7) > dataFrontier)) return "approved_unpaid";
  if (row.dataCoverage === "complete") return "judged";
  return "measuring";
}

/**
 * The month a request first becomes judgeable = the last month of its ROI window.
 *
 * Parsed from the window label the engine already built (`"2026-08 → 2027-03"`) rather than
 * recomputed from payDate + duration, so this can never drift from the window the rest of the
 * module displays and attributes against. Returns null when there is no window yet.
 */
export function roiJudgementMonth(row: RoiTrackerRow): string | null {
  const parts = (row.roiWindow ?? "").split("→");
  const end = (parts[1] ?? "").trim();
  return /^\d{4}-\d{2}$/.test(end) ? end : null;
}

/** True once validated sales data reaches the month a request becomes judgeable. */
export function isJudgeableNow(row: RoiTrackerRow, dataFrontier: string | null): boolean {
  const month = roiJudgementMonth(row);
  return Boolean(month && dataFrontier && month <= dataFrontier);
}
