// Probation DV-Day validation layer (Phase 3: P3-T03 dedup, P3-T04 identity, P3-T05 role,
// P3-T06 window). Pure logic: takes detected DV-Days + resolution context and assigns each a
// dv_status + reason. NOTHING is silently discarded — every day comes out with a status the
// review queue (P3-T08) can surface. Requirement-counting concerns (PM/GPM shared once, role
// caps) live in the scoring/completion layer (Phase 6), not here: an extra valid DV-Day is still
// a real, VALIDATED field day; it simply may not advance an already-satisfied requirement.

import type { DetectedDvDay } from "./dv-detection";
import { dvDayKey } from "./dv-source";

/** Required roles a DV-Day can count toward. */
export type EvaluatorRole = "dm" | "tm" | "pm_gpm" | "nsm";

/** Terminal validation outcome for a detected DV-Day. */
export type DvValidationStatus = "validated" | "duplicate" | "rejected" | "invalid";

export type ProbationCaseRef = {
  caseId: string;
  probationStartDate: string | null;
  probationEndDate: string | null;
  lineName: string | null;
};

export type DvValidationContext = {
  /** Active probation case keyed by normalized employee HR_ID. */
  caseByEmployee: Map<string, ProbationCaseRef>;
  /** app_auth_users.role keyed by normalized evaluator HR_ID (active users only). */
  evaluatorAppRoleByHrId: Map<string, string>;
  /** employee's direct manager HR_ID (normalized) keyed by normalized employee HR_ID. */
  managerHrIdByEmployee: Map<string, string | null>;
  /** dvDayKey()s of DV-Days already persisted — the idempotency/dedup guard (P3-T03). */
  existingDvDayKeys: Set<string>;
};

export type ValidatedDvDay = DetectedDvDay & {
  caseId: string | null;
  evaluatorRole: EvaluatorRole | null;
  dvStatus: DvValidationStatus;
  validationReason: string | null;
};

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Resolve the evaluator's probation role for a specific employee:
 *   - DM: the evaluator IS the employee's direct manager (relationship, not a global role).
 *   - NSM (the Regional Sales Manager counted as one) / TM / PM|GPM: from the evaluator's app_auth_users role.
 *   - PM/GPM is not applicable on the CNS line (mirrors existing probation feedback logic).
 * Returns null when the evaluator holds none of the eligible roles for this employee.
 */
export function resolveEvaluatorRole(
  evaluatorHrId: string,
  employeeHrId: string,
  ctx: DvValidationContext,
  lineName: string | null,
): { role: EvaluatorRole | null; reason: string | null } {
  const evaluator = norm(evaluatorHrId);
  const employee = norm(employeeHrId);

  // DM is a relationship: evaluator is this employee's direct manager.
  const managerHrId = norm(ctx.managerHrIdByEmployee.get(employee));
  if (managerHrId && managerHrId === evaluator) {
    return { role: "dm", reason: null };
  }

  const appRole = ctx.evaluatorAppRoleByHrId.get(evaluator) ?? "";
  // The Regional Sales Manager counts exactly like the National Sales Manager (owner, 2026-10-20,
  // asked whether his double visit with a probation rep should count: "Yes, count it like the NSM").
  if (appRole === "National Sales Manager" || appRole === "Regional Manager") return { role: "nsm", reason: null };
  if (appRole === "Training Manager") return { role: "tm", reason: null };
  if (appRole === "Product Manager" || appRole === "Group Product Manager") {
    if (norm(lineName) === "cns") {
      return { role: null, reason: "pm_gpm_not_applicable_cns" };
    }
    return { role: "pm_gpm", reason: null };
  }

  return { role: null, reason: "evaluator_role_not_eligible" };
}

/**
 * Inclusive [start, end] probation-window test; a missing bound is open on that side.
 *
 * It was exported so the legacy `employee_probation` DV-checkbox auto-tick shared these exact
 * window semantics. That auto-tick was retired 2026-09-01 with the rest of the legacy feedback
 * path, so validateDvDay below is now the only caller. The export stays because these are the
 * authoritative window semantics any future DV reader must gate on — not because something
 * outside this file needs it today.
 */
export function withinWindow(dvDate: string, start: string | null, end: string | null): boolean {
  if (start && dvDate < start) return false;
  if (end && dvDate > end) return false;
  return true;
}

/**
 * Inclusive clamp of a date-only string into [start, end]; a missing bound is open on that side.
 * The write-side companion to withinWindow, used when a DV-Day is opened BY HAND (manual-dv-day.ts)
 * rather than detected from CRM: such a day is dated "today", but a case can still be open past its
 * end date, and an unclamped date would land outside the window every window-scoped reader filters
 * on. Lives here so the clamp and the test it must satisfy stay one file apart from each other.
 */
export function clampToWindow(date: string, start: string | null, end: string | null): string {
  if (start && date < start) return start;
  if (end && date > end) return end;
  return date;
}

/**
 * Validate one detected DV-Day. Order: dedup (idempotency) → identity → role → window.
 * The first failing gate assigns the status; a day passing all gates is "validated".
 */
export function validateDvDay(day: DetectedDvDay, ctx: DvValidationContext): ValidatedDvDay {
  const key = dvDayKey(day.evaluatorHrId, day.employeeHrId, day.dvDate);
  const base = { ...day, caseId: null as string | null, evaluatorRole: null as EvaluatorRole | null };

  // P3-T03 dedup / idempotency: already captured → no-op on write.
  if (ctx.existingDvDayKeys.has(key)) {
    return { ...base, dvStatus: "duplicate", validationReason: "already_captured" };
  }

  // P3-T04 identity: employee must map to an active probation case.
  const probationCase = ctx.caseByEmployee.get(norm(day.employeeHrId));
  if (!probationCase) {
    return { ...base, dvStatus: "invalid", validationReason: "no_probation_case" };
  }

  // P3-T05 role: evaluator must hold an eligible role for this employee.
  const { role, reason: roleReason } = resolveEvaluatorRole(
    day.evaluatorHrId,
    day.employeeHrId,
    ctx,
    probationCase.lineName,
  );
  if (!role) {
    return {
      ...base,
      caseId: probationCase.caseId,
      dvStatus: "invalid",
      validationReason: roleReason ?? "evaluator_role_not_eligible",
    };
  }

  // P3-T06 window: DV date must fall inside the employee's active probation window.
  if (!withinWindow(day.dvDate, probationCase.probationStartDate, probationCase.probationEndDate)) {
    return {
      ...base,
      caseId: probationCase.caseId,
      evaluatorRole: role,
      dvStatus: "rejected",
      validationReason: "outside_probation_window",
    };
  }

  return {
    ...base,
    caseId: probationCase.caseId,
    evaluatorRole: role,
    dvStatus: "validated",
    validationReason: null,
  };
}

/** Validate a batch of detected DV-Days. */
export function validateDvDays(days: DetectedDvDay[], ctx: DvValidationContext): ValidatedDvDay[] {
  return days.map((day) => validateDvDay(day, ctx));
}

/** Convenience: split a validated batch into the ones to persist vs. the review queue (P3-T08). */
export function partitionValidatedDvDays(days: ValidatedDvDay[]): {
  validated: ValidatedDvDay[];
  needsReview: ValidatedDvDay[];
  duplicates: ValidatedDvDay[];
} {
  const validated: ValidatedDvDay[] = [];
  const needsReview: ValidatedDvDay[] = [];
  const duplicates: ValidatedDvDay[] = [];
  for (const day of days) {
    if (day.dvStatus === "validated") validated.push(day);
    else if (day.dvStatus === "duplicate") duplicates.push(day);
    else needsReview.push(day); // rejected | invalid
  }
  return { validated, needsReview, duplicates };
}
