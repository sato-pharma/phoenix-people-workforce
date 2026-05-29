/**
 * Canonical, seat-continuity-aware workforce hierarchy resolution.
 *
 * People report to SEATS (positions / districts), not only to active persons.
 * When a manager resigns, the resignation trigger
 * (`phx_release_terminal_manager_ownership`) reassigns their direct reports
 * UPWARD to the next manager so nobody is orphaned, and stamps each report's
 * `pending_manager_replacement_for_hr_id` with the departed manager's HR_ID so a
 * future replacement re-inherits them automatically.
 *
 * For REPORTING / GROUPING views that upward reassignment must NOT be shown as a
 * real person-to-person reporting line. Example bug: after a Cairo DSM resigns,
 * the Cairo medical reps' `manager_hr_id` points at the NSM, so the Medical Reps
 * Performance view rendered them as direct NSM reports. They must instead stay
 * grouped under the vacant DSM seat (keyed by the departed manager's HR_ID) until
 * a replacement DSM is hired.
 *
 * This module is the single source of truth for that rule so the Organogram,
 * Sales / Medical Reps Performance, and Vacation Report stay aligned. It is
 * intentionally pure and dependency-light (string/number comparisons only) so it
 * is trivially unit-testable and safe to import from any layer.
 */

function trimToNull(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeName(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Identity fields needed to decide where a person reports for grouping. */
export type SeatContinuitySubject = {
  managerHrId?: string | null;
  /**
   * Set by the resignation trigger to the HR_ID of the manager whose seat is now
   * vacant. Treated as a VACANT-SEAT CONTINUITY KEY, never as an active
   * person-to-person manager assignment.
   */
  pendingManagerReplacementForHrId?: string | null;
};

/**
 * True when this person is temporarily held by an upstream manager because their
 * seat-manager resigned and has not yet been replaced.
 */
export function isHeldByVacantSeat(subject: SeatContinuitySubject): boolean {
  return trimToNull(subject.pendingManagerReplacementForHrId) !== null;
}

/**
 * The HR_ID of the seat this person reports to for grouping purposes.
 *
 * Prefers the vacant-seat continuity key (the departed manager's HR_ID) over the
 * upward-reassigned active manager, so resigned-manager reports keep their
 * business grouping under the vacant seat. Falls back to the active manager, then
 * null. The returned value is raw (trimmed only); callers canonicalize as needed.
 */
export function resolveReportingSeatHrId(subject: SeatContinuitySubject): string | null {
  return trimToNull(subject.pendingManagerReplacementForHrId) ?? trimToNull(subject.managerHrId);
}

/** District-identifying fields used to label a vacant seat. */
export type VacantSeatDescriptor = {
  areaName?: string | null;
  teamName?: string | null;
  lineName?: string | null;
};

/**
 * Human label for a vacant seat, derived from the held report's own district so
 * no extra database lookup is required (and so the label is stable across all
 * reports under the same seat). Example: "Cairo — Vacant DSM seat".
 */
export function formatVacantSeatLabel(
  descriptor: VacantSeatDescriptor,
  vacantSeatTitle = "manager seat",
): string {
  const district =
    trimToNull(descriptor.areaName) ??
    trimToNull(descriptor.teamName) ??
    trimToNull(descriptor.lineName);
  return district ? `${district} — Vacant ${vacantSeatTitle}` : `Vacant ${vacantSeatTitle}`;
}

/** Grouping subject for sales-performance member rows. */
export type SeatGroupingSubject = SeatContinuitySubject &
  VacantSeatDescriptor & {
    managerName?: string | null;
  };

export type SeatGrouping = {
  /** Grouping key: the vacant-seat key when held, else the active manager HR_ID. */
  seatHrId: string | null;
  /** Display label for the group header. */
  seatName: string | null;
  /** True when the group represents a vacant seat rather than an active manager. */
  isVacant: boolean;
  /**
   * True when `seatHrId` is a synthetic vacancy-derived key (not a real HR_ID).
   * Callers must NOT canonicalize/normalize it as an HR_ID when this is set.
   */
  seatKeyIsSynthetic: boolean;
};

/** A resolved vacant seat used to group orphaned reports. */
export type ResolvedVacantSeat = {
  /** Stable synthetic grouping key (not an HR_ID). */
  seatKey: string;
  /** Display label for the group header. */
  seatLabel: string;
};

/** Open-vacancy fields used to identify and label a vacant seat. */
export type VacantSeatCandidate = {
  vacancyId: number | string;
  vacancyCode?: string | null;
  areaName?: string | null;
  teamName?: string | null;
  lineName?: string | null;
};

/** Stable synthetic grouping key for a vacant seat (never collides with HR_IDs). */
export function buildVacantSeatKey(candidate: Pick<VacantSeatCandidate, "vacancyId" | "vacancyCode">): string {
  const id = trimToNull(String(candidate.vacancyCode ?? "")) ?? trimToNull(String(candidate.vacancyId ?? ""));
  return `vacant-seat:${id ?? "unknown"}`;
}

/**
 * Pick the single unambiguous vacant seat from a candidate list.
 *
 * Returns the seat ONLY when exactly one candidate exists. With zero candidates
 * there is nothing to attach to; with more than one the correct seat cannot be
 * determined from the available fields (no district/territory hierarchy), so we
 * refuse to guess and report `ambiguous` for the caller to log. This is what
 * keeps the fallback safe and prevents unrelated reps from being mis-grouped.
 */
export function selectVacantManagerSeat(
  candidates: VacantSeatCandidate[],
  vacantSeatTitle = "manager seat",
): { seat: ResolvedVacantSeat | null; ambiguous: boolean } {
  if (candidates.length !== 1) {
    return { seat: null, ambiguous: candidates.length > 1 };
  }
  const candidate = candidates[0];
  return {
    seat: {
      seatKey: buildVacantSeatKey(candidate),
      seatLabel: formatVacantSeatLabel(candidate, vacantSeatTitle),
    },
    ambiguous: false,
  };
}

export type SeatGroupingOptions = {
  vacantSeatTitle?: string;
  /**
   * Fallback for when the continuity marker was lost: the report's manager was
   * reassigned up to the NSM AND a single open DSM vacancy unambiguously
   * identifies the vacant seat. Only applied when there is no pending marker.
   */
  orphanFallback?: {
    isOrphanToNsm: boolean;
    vacantSeat: ResolvedVacantSeat | null;
  };
};

/**
 * Resolve how a single report should be grouped in performance views, with a
 * two-tier seat-continuity precedence:
 *
 *   1. `pending_manager_replacement_for_hr_id` — the authoritative marker stamped
 *      by the resignation trigger (grouped under the departed manager's HR_ID).
 *   2. Vacancy fallback — when the marker is missing but the report is orphaned
 *      up to the NSM and exactly one open DSM vacancy exists for the line, group
 *      under that vacant seat (synthetic key).
 *
 * Otherwise grouping is unchanged (active manager HR_ID + name), preserving
 * existing behaviour exactly.
 */
export function resolveSeatGrouping(
  subject: SeatGroupingSubject,
  options: SeatGroupingOptions = {},
): SeatGrouping {
  const vacantSeatTitle = options.vacantSeatTitle ?? "manager seat";

  if (isHeldByVacantSeat(subject)) {
    return {
      seatHrId: trimToNull(subject.pendingManagerReplacementForHrId),
      seatName: formatVacantSeatLabel(subject, vacantSeatTitle),
      isVacant: true,
      seatKeyIsSynthetic: false,
    };
  }

  const fallback = options.orphanFallback;
  if (fallback?.isOrphanToNsm && fallback.vacantSeat) {
    return {
      seatHrId: fallback.vacantSeat.seatKey,
      seatName: fallback.vacantSeat.seatLabel,
      isVacant: true,
      seatKeyIsSynthetic: true,
    };
  }

  return {
    seatHrId: trimToNull(subject.managerHrId),
    seatName: trimToNull(subject.managerName),
    isVacant: false,
    seatKeyIsSynthetic: false,
  };
}

/** Line + department fields used for department-safe scope checks. */
export type LineDepartmentSubject = {
  departmentId?: number | null;
  departmentName?: string | null;
  lineId?: number | null;
  lineName?: string | null;
};

/**
 * Same product line. Prefers numeric `lineId`; falls back to a normalized
 * `lineName` comparison. Mirrors the existing vacation line-matching semantics.
 */
export function sameWorkforceLine(a: LineDepartmentSubject, b: LineDepartmentSubject): boolean {
  if (a.lineId != null && b.lineId != null) return a.lineId === b.lineId;
  const an = normalizeName(a.lineName);
  const bn = normalizeName(b.lineName);
  return Boolean(an && bn && an === bn);
}

/**
 * Same department. Prefers numeric `departmentId`; falls back to a normalized
 * `departmentName` comparison. When department information is entirely missing on
 * both sides they are treated as matching; when present on one side only they do
 * NOT match (fail closed, so cross-department data never leaks).
 */
export function sameWorkforceDepartment(
  a: LineDepartmentSubject,
  b: LineDepartmentSubject,
): boolean {
  if (a.departmentId != null && b.departmentId != null) return a.departmentId === b.departmentId;
  const an = normalizeName(a.departmentName);
  const bn = normalizeName(b.departmentName);
  if (an && bn) return an === bn;
  // One side carries department info the other lacks -> treat as different.
  return an === bn;
}

/**
 * Department-safe LINE scope. A LINE-scoped viewer (e.g. National Sales Manager,
 * Product Manager) may only see colleagues in the SAME line AND the SAME
 * department. This keeps a Sales NSM from seeing Marketing employees who merely
 * share the same product line, and symmetrically keeps Marketing roles within
 * their own department.
 */
export function lineScopeIncludesEmployee(
  viewer: LineDepartmentSubject,
  employee: LineDepartmentSubject,
): boolean {
  return sameWorkforceLine(viewer, employee) && sameWorkforceDepartment(viewer, employee);
}
