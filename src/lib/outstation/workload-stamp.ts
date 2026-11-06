/**
 * The CRM workload a trip is stamped with, and refreshing a stamp that was taken too early.
 *
 * Why it exists (owner, 2026-10-22: "fix the stale no-activity stamp"). A trip's AM · PM ·
 * Pharmacies figures are read from the CRM at the moment the departure photo lands — and a
 * manager usually takes that photo BEFORE he has typed the day's visits. Osama Mohamed El-said's
 * 7 Oct Assiut trip was stamped "no activity, 0 / 0" at 19:22 Cairo; his nine visits were saved
 * between 22:26 and 22:33 the same night. Nothing ever looked again: the workload gate already
 * read "complete", and the only repair (retryOutstationWorkloadCapture) accepts `pending_workload`
 * alone. So the approver read "he did nothing" on a day he worked. Production held 23 undecided
 * claims stamped zero when this was found.
 *
 * The refresh is EVIDENCE ONLY. It never moves money, never touches the gate status (the gate is
 * already complete) and never bumps `updated_at` — the claim's approval revision
 * (claim-revision.ts) belongs to changes that move money, exactly as the first stamp leaves it.
 *
 * Pure: every rule here is asserted without a database or a CRM.
 */

import type { OutstationWorkloadCapture } from "@/lib/outstation/workload-capture";
import { capturedWorkloadMatchStatus } from "@/lib/outstation/workload-rollup";
import { isOutstationClaimUndecided } from "@/lib/outstation/undecided-claim";

/** How far back a finished trip is still re-read. Past this, a claim is long in someone's hands. */
export const WORKLOAD_RESTAMP_WINDOW_DAYS = 45;

/** One run's cap, so a backlog can never turn the morning job into a CRM flood. */
export const WORKLOAD_RESTAMP_MAX_ROWS = 200;

/** The `workload_source` the system's own CRM read writes. */
export const SYSTEM_WORKLOAD_SOURCE = "ireports360";

function isoDay(value: unknown): string | null {
  const day = String(value ?? "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The YYYY-MM-DD `days` before `todayCairo`, in calendar days. */
export function restampWindowStart(todayCairo: string, days = WORKLOAD_RESTAMP_WINDOW_DAYS): string {
  const today = isoDay(todayCairo);
  if (!today) return "9999-12-31";
  const cursor = new Date(`${today}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() - days);
  return cursor.toISOString().slice(0, 10);
}

/**
 * May this claim's workload be read again? Every condition must hold:
 *   - nobody has decided it (an approver may already have read the old figure and acted on it);
 *   - the system stamped it — the gate reads `complete` and the source is the CRM read — so a figure
 *     a Super Admin TYPED (`manual` / `override` / `manual_override`) is never overwritten;
 *   - the trip is over (its last day is before today, Cairo) — a running trip is still collecting
 *     visits and is stamped at its departure photo anyway;
 *   - the trip ended inside the window.
 */
export function isWorkloadRestampCandidate(
  row: {
    status: unknown;
    tripEndDate: unknown;
    workloadGateStatus: unknown;
    workloadMatchStatus: unknown;
    workloadSource: unknown;
  },
  todayCairo: string,
): boolean {
  if (!isOutstationClaimUndecided(row.status)) return false;
  if (String(row.workloadGateStatus ?? "") !== "complete") return false;
  if (String(row.workloadSource ?? "") !== SYSTEM_WORKLOAD_SOURCE) return false;
  if (String(row.workloadMatchStatus ?? "") === "manual_override") return false;
  const tripEnd = isoDay(row.tripEndDate);
  const today = isoDay(todayCairo);
  if (!tripEnd || !today) return false;
  if (tripEnd >= today) return false;
  return tripEnd >= restampWindowStart(today);
}

/** AM + PM + Pharmacies, with a missing third figure read as none. */
export function storedWorkloadTotal(row: {
  amWorkload: number | null | undefined;
  pharmacyWorkload: number | null | undefined;
  pmWorkload: number | null | undefined;
}): number {
  return (
    Math.max(0, Number(row.amWorkload) || 0) +
    Math.max(0, Number(row.pmWorkload) || 0) +
    Math.max(0, Number(row.pharmacyWorkload) || 0)
  );
}

/**
 * Write the fresh read only when it found MORE work than the stamp holds.
 *
 * Never downwards: a lower live figure means a visit was deleted or re-dated after the stamp, and
 * that is a question for a person, not something a morning job quietly rewrites. An equal figure
 * is a no-op, so a correct stamp is never touched.
 */
export function shouldRestampWorkload(
  stored: {
    amWorkload: number | null | undefined;
    pharmacyWorkload: number | null | undefined;
    pmWorkload: number | null | undefined;
    workloadMatchStatus?: unknown;
  },
  live: { amWorkload: number; meetingDates?: readonly string[]; pharmacyWorkload: number; pmWorkload: number },
): boolean {
  if (storedWorkloadTotal(live) > storedWorkloadTotal(stored)) return true;
  // A stamp of "no activity" taken before the day's meeting was saved (Weaam Gweed, 5 Oct 2026:
  // stamped 13:09, the meeting saved 13:54). The figures stay as they are; only the verdict moves,
  // and only upward — from "no activity" to the meeting the CRM now holds.
  return String(stored.workloadMatchStatus ?? "") === "no_activity" && capturedWorkloadMatchStatus(live) === "matched";
}

/**
 * The columns a captured workload writes — ONE shape for the first stamp (taken when the
 * departure photo lands) and for every refresh, so the two can never disagree on what a stamp is.
 * `previousStamp` is recorded on a refresh, so an approver can see the figure moved and from what.
 */
export function capturedWorkloadColumns(
  capture: Extract<OutstationWorkloadCapture, { captured: true }>,
  now: string,
  previousStamp?: {
    amWorkload: number | null;
    matchedAt: string | null;
    pharmacyWorkload: number | null;
    pmWorkload: number | null;
  },
) {
  return {
    am_workload: capture.amWorkload,
    // AM · PM · Pharmacies: pharmacy visits are the third figure, never inside AM or PM.
    pharmacy_workload: capture.pharmacyWorkload,
    pm_workload: capture.pmWorkload,
    workload_matched_at: now,
    // Kept in step with the numbers being written — a repaired row must never read "no_activity"
    // beside a real AM 2 / PM 7. Pharmacy visits count as work (owner, 2026-09-21).
    workload_match_status: capturedWorkloadMatchStatus(capture),
    workload_source: SYSTEM_WORKLOAD_SOURCE,
    // The per-day breakdown and who was counted, so an approver can see WHY the number is what it is.
    workload_evidence_snapshot: {
      contributingHrIds: capture.contributingHrIds,
      days: capture.days,
      hops: capture.hops,
      sourceLabel: capture.sourceLabel,
      ...(previousStamp ? { refreshedFrom: previousStamp } : {}),
    },
  };
}
