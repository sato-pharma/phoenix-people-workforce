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

import { todayInCairo } from "@/lib/date-only";
import type { RoiTrackerRow } from "@/lib/marketing-requests/roi-tracker-service";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";

/**
 * The request statuses the live tracker ASKS the report for — explicitly, every time.
 *
 * 🔴 Sending an empty status list is NOT "everything". getMarketingRoiReport reads an empty list as
 * its executive default (approved money only — resolveRoiStatusScope), and that default arrived on
 * 2026-08-04, six days after this tracker was built on the old all-statuses behaviour. From then on
 * the "Awaiting approval", "Rejected" and "Cancelled" tiles and the "Waiting on a person" queue could
 * never hold a single request: measured on production 2026-10-09, 27 of the 52 Phoenix requests
 * (13 pending approval, 5 sent back, 8 rejected, 1 cancelled — EGP 137,950) never reached the page.
 *
 * A draft is left out on purpose: it has not entered the chain, nobody is holding it, and it is the
 * requester's own unsubmitted work.
 */
export const ROI_LIVE_TRACKER_STATUSES: readonly MarketingRequestStatus[] = [
  "pending_validation",
  "pending_approval",
  "returned",
  "finance_hold",
  "approved",
  "active",
  "roi_tracking",
  "closed",
  "archived",
  "rejected",
  "cancelled",
];

/**
 * Where a request sits in its life. STAGES, not verdicts — how a campaign performed lives in
 * `resultStatus`; this answers only "where is the money right now".
 */
export type RoiLifecycleStage =
  | "rejected"
  | "cancelled"
  | "awaiting_approval"
  | "approved_unpaid"
  | "measuring"
  | "judged";

/** Statuses that mean nobody has committed the money yet — a decision is still outstanding. */
const AWAITING_STATUSES = new Set(["draft", "pending_validation", "pending_approval", "returned", "finance_hold"]);

/**
 * Order is load-bearing:
 *
 * 1. `rejected` is checked FIRST so turned-down money can never be counted as committed. Production
 *    carries rejected requests that still have a pay date (10 of them, one dated in the future), so
 *    testing the pay date before the status would silently promote refused spend into the pipeline.
 * 2. "Not yet paid" means exactly that: no pay date, or a pay date still in the future (Cairo).
 *    🔴 It used to mean "pay month beyond the validated-data frontier", which is a fact about the
 *    SALES FILES, not about the payment — so every campaign paid after the last complete sales month
 *    read "Not yet paid · the ROI clock has not started" on a card that also printed its pay date.
 *    Measured 2026-10-09: all 15 requests on that tile had been paid (latest 1 Oct 2026), one of them
 *    with EGP 35,751 already attributed. A paid request the data has not reached yet is MEASURING.
 * 3. Only once the window is fully covered by validated sales (`dataCoverage === "complete"`) is a
 *    request judgeable. Everything else in flight is still measuring.
 *
 * `today` is a Cairo YYYY-MM-DD; it defaults to the real date and is a parameter only so tests can
 * pin it.
 */
export function roiLifecycleStage(
  // Structural, not `RoiTrackerRow`, so the SERVER can name a request's stage without first
  // materialising a full tracker row. The Case File has to state a stage for requests the ROI
  // engine deliberately never returns (draft / returned / rejected), and every RoiTrackerRow still
  // satisfies this — no caller changes.
  row: Pick<RoiTrackerRow, "dataCoverage" | "payDate" | "status">,
  today: string = todayInCairo(),
): RoiLifecycleStage {
  if (row.status === "rejected") return "rejected";
  // A cancelled request was called off after entering the chain. Like a refusal, none of its money
  // is committed, so it is checked before the pay-date arms below can promote it into the pipeline.
  if (row.status === "cancelled") return "cancelled";
  if (AWAITING_STATUSES.has(row.status)) return "awaiting_approval";
  if (!row.payDate || row.payDate.slice(0, 10) > today) return "approved_unpaid";
  if (row.dataCoverage === "complete") return "judged";
  return "measuring";
}

/**
 * Stages whose money is NOT committed: refused, called off, or still waiting for a decision. The
 * module's own definition (AWAITING_STATUSES above: "nobody has committed the money yet") — the
 * tracker's "committed" figures leave all three out.
 */
export function isUncommittedStage(stage: RoiLifecycleStage): boolean {
  return stage === "rejected" || stage === "cancelled" || stage === "awaiting_approval";
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
