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

/**
 * Canonical, seat-continuity-aware manager-hierarchy membership.
 *
 * These helpers are the single source of truth for "does this report belong to a
 * given manager's team / management chain", honoring vacant-seat continuity so
 * reporting/scope views stay aligned with the organogram. They are pure: the
 * caller injects its own HR_ID canonicalization (e.g. canonicalHrIdKey) so the
 * resolver does not depend on any HR_ID dialect.
 *
 * Design note: the resignation trigger reassigns a departed manager's reports
 * UPWARD (their `manager_hr_id` becomes the grandparent) AND stamps
 * `pending_manager_replacement_for_hr_id` with the departed manager's HR_ID. So
 * the *manager* edge stays connected to active nodes (good for climbing), while
 * the *pending* marker records the vacant seat the report is held for. Both
 * helpers therefore (a) climb via `manager_hr_id` to keep the chain connected and
 * (b) ALSO match the viewer against the vacant-seat marker. They are strictly
 * additive vs a raw `manager_hr_id` walk: they never remove reachability, they
 * only also recognize the owner of the vacant seat.
 */

type CanonicalizeHrId = (hrId: string | null | undefined) => string | null;

function matchesViewer(
  value: string | null | undefined,
  viewerCanonicalHrId: string,
  canonicalize: CanonicalizeHrId,
): boolean {
  const canonical = canonicalize(value);
  return canonical !== null && canonical === viewerCanonicalHrId;
}

/**
 * Does `employee` report DIRECTLY to the viewer's seat — either via the current
 * `manager_hr_id` or via the vacant-seat continuity marker? Use for TEAM scope.
 */
export function reportsToManagerSeat(input: {
  employee: SeatContinuitySubject;
  viewerCanonicalHrId: string;
  canonicalize: CanonicalizeHrId;
}): boolean {
  const { employee, viewerCanonicalHrId, canonicalize } = input;
  return (
    matchesViewer(employee.managerHrId, viewerCanonicalHrId, canonicalize) ||
    matchesViewer(employee.pendingManagerReplacementForHrId, viewerCanonicalHrId, canonicalize)
  );
}

/**
 * Is `employee` anywhere in the viewer's management chain, seat-continuity aware?
 * Climbs `manager_hr_id` (the connected edge after upward reassignment) and at
 * every level also matches the viewer against the vacant-seat marker, so a viewer
 * who owns a vacant seat above the report still sees it. Use for HIERARCHY scope.
 *
 * `byCanonicalHrId` must be keyed by `canonicalize(hrId)`.
 */
export function isWithinManagerHierarchy(input: {
  employee: SeatContinuitySubject;
  byCanonicalHrId: ReadonlyMap<string, SeatContinuitySubject>;
  viewerCanonicalHrId: string;
  canonicalize: CanonicalizeHrId;
}): boolean {
  const { byCanonicalHrId, viewerCanonicalHrId, canonicalize } = input;
  let node: SeatContinuitySubject | undefined = input.employee;
  const visited = new Set<string>();

  while (node) {
    if (
      matchesViewer(node.managerHrId, viewerCanonicalHrId, canonicalize) ||
      matchesViewer(node.pendingManagerReplacementForHrId, viewerCanonicalHrId, canonicalize)
    ) {
      return true;
    }

    const nextKey = canonicalize(node.managerHrId);
    if (!nextKey || visited.has(nextKey)) break;
    visited.add(nextKey);
    node = byCanonicalHrId.get(nextKey);
  }

  return false;
}

/** Region-identifying field for the Regional Manager scope helpers below. */
export type RegionSubject = {
  regionName?: string | null;
};

/**
 * Normalizes a region label the same way `regionsWithinManagerHierarchy` keys its result Set, so
 * callers can safely do `regionKeys.has(normalizeRegionLabel(candidate.regionName))`.
 */
export function normalizeRegionLabel(value: string | null | undefined): string {
  return normalizeName(value);
}

/**
 * Owner rule (2026-07-18): a Regional Manager owns exactly ONE product line across a specific set
 * of regions. The RM's OWN `region_name` is often a coarse parent label ("Alexandria + Delta")
 * that does not string-match the finer labels on their reports ("Delta (1)", "ALEX-BHR", …), so
 * the region set must be derived from the RM's own management subtree instead.
 *
 * Returns the canonicalized region labels covering everyone within the viewer's hierarchy —
 * chain-walked via `isWithinManagerHierarchy` (seat-continuity aware), not limited to direct
 * reports, so it stays correct even if a direct report's own region field is blank/coarse but
 * their team's isn't. Combine with `sameWorkforceLine` to bound an RM's scope: same line AND
 * region in this set.
 */
export function regionsWithinManagerHierarchy<T extends SeatContinuitySubject & RegionSubject & { hrId: string }>(
  employees: readonly T[],
  viewerCanonicalHrId: string,
  canonicalize: CanonicalizeHrId,
): Set<string> {
  const byCanonicalHrId = new Map<string, T>();
  for (const employee of employees) {
    const key = canonicalize(employee.hrId);
    if (key) byCanonicalHrId.set(key, employee);
  }
  const regions = new Set<string>();
  for (const employee of employees) {
    if (!isWithinManagerHierarchy({ employee, byCanonicalHrId, viewerCanonicalHrId, canonicalize })) continue;
    const region = normalizeRegionLabel(employee.regionName);
    if (region) regions.add(region);
  }
  return regions;
}

/**
 * The same region set as `regionsWithinManagerHierarchy`, as the labels a person reads — one per
 * region, in its first-seen spelling, sorted ("Alex-BHR", "Delta (1)", "Delta (2)"). This is what a
 * Regional Manager's territory says: his own `region_name` holds ONE of his regions (Hany Saad's
 * reads "Alex-BHR" while his seat runs Alex-BHR, Delta (1) and Delta (2) — 2026-11-09).
 */
export function regionLabelsWithinManagerHierarchy<T extends SeatContinuitySubject & RegionSubject & { hrId: string }>(
  employees: readonly T[],
  viewerCanonicalHrId: string,
  canonicalize: CanonicalizeHrId,
): string[] {
  const keys = regionsWithinManagerHierarchy(employees, viewerCanonicalHrId, canonicalize);
  const labels = new Map<string, string>();
  for (const employee of employees) {
    const key = normalizeRegionLabel(employee.regionName);
    if (key && keys.has(key) && !labels.has(key)) labels.set(key, employee.regionName!.trim());
  }
  return [...labels.values()].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));
}
