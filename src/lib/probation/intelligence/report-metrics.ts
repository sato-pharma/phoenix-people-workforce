// Probation report pure metrics (Phase 7, P7-T02/T03). Milestones + DV-Day progress rollup.
// Pure so they are unit-testable without a DB.

import { addDaysToDateOnly, parseDateOnly } from "@/lib/date-only";

import type { ProbationConfig } from "./config";
import type { ProbationEvaluatorRole } from "./types";

// The milestone schedule is fixed by policy (must remain Day 30 / 60 / 75).
export const PROBATION_MILESTONE_DAYS = [30, 60, 75] as const;

export type MilestoneStatus = {
  day: number;
  label: string;
  date: string | null;
  reached: boolean;
};

function dayDiff(fromDate: string, toDate: string): number {
  const a = parseDateOnly(fromDate);
  const b = parseDateOnly(toDate);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** Current probation day (1-based day count since hire) as of `today`. */
export function currentProbationDay(hireDate: string | null, today: string): number | null {
  if (!hireDate) return null;
  return Math.max(0, dayDiff(hireDate, today)) + 1;
}

/** Milestone status list (Day 30/60/75): each with its calendar date and whether it's reached. */
export function milestoneStatuses(hireDate: string | null, today: string): MilestoneStatus[] {
  const curDay = currentProbationDay(hireDate, today);
  return PROBATION_MILESTONE_DAYS.map((day) => ({
    day,
    label: `Day ${day}`,
    date: hireDate ? addDaysToDateOnly(hireDate, day - 1) : null,
    reached: curDay != null && curDay >= day,
  }));
}

// ── DV-Day progress rollup (P7-T03) ──────────────────────────────────────────

export type RoleProgress = {
  role: ProbationEvaluatorRole;
  required: number;
  validated: number; // DV-Days validated (task exists) for this role
  feedbackCompleted: number; // DV-Days with feedback submitted
  complete: boolean; // feedbackCompleted >= required
};

export type DvProgress = {
  byRole: Record<ProbationEvaluatorRole, RoleProgress>;
  totalRequired: number;
  totalValidated: number;
  totalFeedbackCompleted: number;
};

const ROLE_KEYS: ProbationEvaluatorRole[] = ["dm", "tm", "pm_gpm", "nsm"];

export type DvDayLite = {
  evaluatorRole: ProbationEvaluatorRole | null;
  dvStatus: string; // validated | feedback_completed | ...
};

/**
 * Roll up DV-Day counts per role against the configured requirements.
 * "validated" counts DV-Days in a countable state (validated OR feedback_completed);
 * "feedbackCompleted" counts those with feedback submitted.
 */
export function computeDvProgress(dvDays: DvDayLite[], config: ProbationConfig): DvProgress {
  const byRole = {} as Record<ProbationEvaluatorRole, RoleProgress>;
  for (const role of ROLE_KEYS) {
    byRole[role] = { role, required: config.requirements[role] ?? 0, validated: 0, feedbackCompleted: 0, complete: false };
  }

  for (const d of dvDays) {
    if (!d.evaluatorRole || !(ROLE_KEYS as string[]).includes(d.evaluatorRole)) continue;
    const rp = byRole[d.evaluatorRole];
    if (d.dvStatus === "validated" || d.dvStatus === "feedback_completed") rp.validated += 1;
    if (d.dvStatus === "feedback_completed") rp.feedbackCompleted += 1;
  }

  let totalRequired = 0, totalValidated = 0, totalFeedbackCompleted = 0;
  for (const role of ROLE_KEYS) {
    const rp = byRole[role];
    // A role that is not required (required <= 0) counts as complete for progress, matching scoring.
    rp.complete = rp.required <= 0 ? true : rp.feedbackCompleted >= rp.required;
    totalRequired += rp.required;
    totalValidated += rp.validated;
    totalFeedbackCompleted += rp.feedbackCompleted;
  }

  return { byRole, totalRequired, totalValidated, totalFeedbackCompleted };
}
