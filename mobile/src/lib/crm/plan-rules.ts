/**
 * Phoenix CRM — the weekly plan's rules on the phone, with no I/O.
 *
 * PURE PORT of the web `src/lib/phoenix-crm/plan-rules.ts` and `coverage.ts`, cut to what the native
 * Plan screen needs: the exception reasons a customer can be placed on a day off with, the note limits,
 * and the grade target that decides a customer's month standing. The server applies the very same rules
 * when it saves (resolvePlanItems), so a slip caught here is one the save would also refuse.
 */

import type { CrmGrade, CrmListType, CrmPlanStatus, PlanExceptionType, PlanGradeTargets } from "@/lib/crm/types";

export const PLAN_EXCEPTION_TYPES: ReadonlyArray<{ key: PlanExceptionType; label: string }> = [
  { key: "another_place", label: "At another place" },
  { key: "by_appointment", label: "By appointment" },
  { key: "timings_changed", label: "Timings changed" },
  { key: "other", label: "Other (write a note)" },
];

export const PLAN_NOTE_MAX = 300;
export const PLAN_DECISION_NOTE_MAX = 500;

export function exceptionLabel(type: string | null): string | null {
  if (!type) return null;
  return PLAN_EXCEPTION_TYPES.find((entry) => entry.key === type)?.label ?? null;
}

export function planStatusLabel(status: CrmPlanStatus | null): string {
  if (status === "submitted") return "Waiting for review";
  if (status === "approved") return "Approved";
  if (status === "returned") return "Returned for changes";
  if (status === "draft") return "Draft";
  return "Not started";
}

/** The visits a grade expects that month, per list. Null = no number, so it counts for coverage only. */
export function gradeTarget(targets: PlanGradeTargets, listType: CrmListType, grade: CrmGrade | null): number | null {
  if (!grade) return null;
  return targets[listType]?.[grade] ?? null;
}

/** 0 = not visited this month · 1 = behind its grade · 2 = on or over its grade. Lower plans first. */
export type CoverageTier = 0 | 1 | 2;

export function coverageTier(visitsThisMonth: number, target: number | null): CoverageTier {
  if (visitsThisMonth <= 0) return 0;
  if (target !== null && visitsThisMonth < target) return 1;
  return 2;
}
