// Canonical probation date logic — the SINGLE source of truth for probation-period dates.
//
// Owner-locked business rule: probation end date = hire date + 90 days (NOT "+3 calendar months").
// Every layer (DB backfill, services, provisioning, UI, emails, reports, cron, decision logic)
// must derive dates through these helpers. The prior `hire + 3 months` path in provisioning.ts
// is removed in favor of this module. lifecycle-risk/metrics.ts's `probationEndDateFromHire`
// uses the identical +90 formula; a unit test asserts the two agree so they can never drift.

import { addDaysToDateOnly, parseDateOnly, toDateOnlyString } from "@/lib/date-only";

/** Fixed probation length in days. */
export const PROBATION_TOTAL_DAYS = 90;

/**
 * Field-assessment window: all required DV-Days + feedback must complete within the first
 * 75 days so the CEO has time to decide before day 90.
 */
export const PROBATION_ASSESSMENT_WINDOW_DAYS = 75;

/** Milestone days (kept fixed by policy — emails change purpose, schedule does not). */
export const PROBATION_MILESTONE_DAYS = [30, 60, 75] as const;
export type ProbationMilestoneDay = (typeof PROBATION_MILESTONE_DAYS)[number];

/** Probation start date defaults to the hire date unless an explicit start is provided. */
export function probationStartDate(
  hireDate: string | null | undefined,
  explicitStart?: string | null,
): string | null {
  const start = toDateOnlyString(explicitStart ?? null) ?? toDateOnlyString(hireDate ?? null);
  return start;
}

/**
 * Canonical probation end date = start + 90 days. Uses the probation start when supplied,
 * otherwise the hire date. Returns null for a null/unparseable input (corrected-hire-date safe).
 */
export function probationEndDate(
  hireDate: string | null | undefined,
  explicitStart?: string | null,
): string | null {
  const start = probationStartDate(hireDate, explicitStart);
  return addDaysToDateOnly(start, PROBATION_TOTAL_DAYS);
}

/**
 * Current probation day (1-based) as of `reference` (default today), clamped to [0, 90+].
 * Day 1 = hire date. Returns null when the start is unknown.
 */
export function currentProbationDay(
  hireDate: string | null | undefined,
  reference: Date = new Date(),
  explicitStart?: string | null,
): number | null {
  const start = parseDateOnly(probationStartDate(hireDate, explicitStart));
  if (!start) return null;
  const startMs = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const ref = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();
  const elapsed = Math.floor((ref - startMs) / 86400000);
  return Math.max(0, elapsed) + 1;
}

/** Days remaining until the probation end date (may be negative once past). Null if unknown. */
export function probationDaysRemaining(
  hireDate: string | null | undefined,
  reference: Date = new Date(),
  explicitStart?: string | null,
): number | null {
  const end = parseDateOnly(probationEndDate(hireDate, explicitStart));
  if (!end) return null;
  const endMs = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  const ref = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate()).getTime();
  return Math.ceil((endMs - ref) / 86400000);
}

/** True when the employee is still within the 90-day window as of `reference`. */
export function isWithinProbationWindow(
  hireDate: string | null | undefined,
  reference: Date = new Date(),
  explicitStart?: string | null,
): boolean {
  const remaining = probationDaysRemaining(hireDate, reference, explicitStart);
  return remaining !== null && remaining > 0;
}

/** Absolute calendar date of a given milestone day (start + N days). */
export function probationMilestoneDate(
  hireDate: string | null | undefined,
  milestoneDay: number,
  explicitStart?: string | null,
): string | null {
  return addDaysToDateOnly(probationStartDate(hireDate, explicitStart), milestoneDay);
}
