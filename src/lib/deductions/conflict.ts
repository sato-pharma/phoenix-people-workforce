// Unified Deductions module: pure conflict-detection helpers. No DB I/O.
// Ported from deductions-governance/conflict.ts, keyed by category instead of
// deductionType so cross-category same-day overlaps (e.g. CRM vs No Records
// Activity both claiming the same day) surface too — see the mutual-exclusion
// rule from deductions-governance/no-activity-clarifications.ts this generalizes.

import { canonicalHrIdKey } from "../hr-id.ts";
import { normalizeMonthKey } from "./candidate-key.ts";
import type { DeductionsCategory } from "./types.ts";

export function findDateOverlap(a: readonly string[], b: readonly string[]): string[] {
  const bSet = new Set<string>();
  for (const value of b) {
    if (typeof value === "string") {
      bSet.add(value.trim());
    }
  }
  const overlap = new Set<string>();
  for (const value of a) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (bSet.has(trimmed)) {
      overlap.add(trimmed);
    }
  }
  return [...overlap].sort();
}

export type DeductionsConflictResult = {
  conflicts: boolean;
  overlappingDates: string[];
  reason: string | null;
};

type ConflictCandidate = {
  employeeHrId: string;
  monthKey: string;
  category: DeductionsCategory;
  dates: readonly string[];
};

/**
 * Same-category conflict: the same employee, month, and category already has
 * an overlapping day (a duplicate/refreshed candidate from the same pipeline).
 */
export function detectCandidateConflict(a: ConflictCandidate, b: ConflictCandidate): DeductionsConflictResult {
  const aHr = canonicalHrIdKey(a.employeeHrId);
  const bHr = canonicalHrIdKey(b.employeeHrId);
  if (!aHr || !bHr || aHr !== bHr) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  let aMonth: string;
  let bMonth: string;
  try {
    aMonth = normalizeMonthKey(a.monthKey);
    bMonth = normalizeMonthKey(b.monthKey);
  } catch {
    return { conflicts: false, overlappingDates: [], reason: null };
  }
  if (aMonth !== bMonth) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  if (a.category !== b.category) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  const overlappingDates = findDateOverlap(a.dates, b.dates);
  if (overlappingDates.length === 0) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  return {
    conflicts: true,
    overlappingDates,
    reason: `Same employee, month, and category with overlapping dates (${overlappingDates.join(", ")})`,
  };
}

/**
 * Cross-category conflict: the same employee/day is claimed by two DIFFERENT
 * categories (e.g. CRM and No Records Activity both cover 2026-06-10 for the
 * same employee). Unlike detectCandidateConflict this does not require the
 * same category — it's the generalization of deductions-governance's
 * MANUAL_HR-vs-FIELD_WORKFORCE mutual-exclusion check to all 7 categories, so
 * the same day is never double-counted across pipelines.
 */
export function detectCrossCategoryConflict(a: ConflictCandidate, b: ConflictCandidate): DeductionsConflictResult {
  const aHr = canonicalHrIdKey(a.employeeHrId);
  const bHr = canonicalHrIdKey(b.employeeHrId);
  if (!aHr || !bHr || aHr !== bHr) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  let aMonth: string;
  let bMonth: string;
  try {
    aMonth = normalizeMonthKey(a.monthKey);
    bMonth = normalizeMonthKey(b.monthKey);
  } catch {
    return { conflicts: false, overlappingDates: [], reason: null };
  }
  if (aMonth !== bMonth) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  if (a.category === b.category) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  const overlappingDates = findDateOverlap(a.dates, b.dates);
  if (overlappingDates.length === 0) {
    return { conflicts: false, overlappingDates: [], reason: null };
  }

  return {
    conflicts: true,
    overlappingDates,
    reason: `This day is already tracked by the "${a.category}" pipeline — decide it there instead of duplicating it under "${b.category}" (overlapping dates: ${overlappingDates.join(", ")})`,
  };
}

export type DeductionsDayCollision = {
  employeeHrId: string;
  employeeName: string | null;
  date: string;
  categories: DeductionsCategory[];
};

/**
 * Every (employee, day) claimed by MORE THAN ONE candidate in a set — the
 * double-deduction check, run across a whole month at once.
 *
 * This is the set-wide counterpart to detectCrossCategoryConflict's pairwise
 * check: publishing is an all-at-once operation, so the question that actually
 * matters is "does any day appear twice anywhere in what I'm about to pay?",
 * not "do these two specific rows clash?". O(n) over candidates rather than
 * O(n²) pairwise, which matters at ~2,000 candidates a month.
 *
 * Pure — no DB I/O — so it can be unit-tested and reused by both the collection
 * warning path and the publish gate.
 */
export function findDayCollisions(
  candidates: ReadonlyArray<{
    employeeHrId: string;
    employeeName?: string | null;
    employeeHrIdCompact: string;
    category: DeductionsCategory;
    dates: readonly string[];
  }>,
): DeductionsDayCollision[] {
  const seen = new Map<
    string,
    { employeeHrId: string; employeeName: string | null; date: string; categories: Set<DeductionsCategory> }
  >();

  for (const candidate of candidates) {
    for (const rawDate of candidate.dates) {
      if (typeof rawDate !== "string") continue;
      const date = rawDate.trim();
      if (!date) continue;
      const key = `${candidate.employeeHrIdCompact}:${date}`;
      const entry = seen.get(key);
      if (entry) {
        entry.categories.add(candidate.category);
      } else {
        seen.set(key, {
          employeeHrId: candidate.employeeHrId,
          employeeName: candidate.employeeName ?? null,
          date,
          categories: new Set([candidate.category]),
        });
      }
    }
  }

  const collisions: DeductionsDayCollision[] = [];
  for (const entry of seen.values()) {
    // >1 category means two different pipelines claimed the same day. A single
    // category appearing twice for one day is caught by the (category,
    // candidate_key) unique index at insert time, so it cannot reach here.
    if (entry.categories.size > 1) {
      collisions.push({
        employeeHrId: entry.employeeHrId,
        employeeName: entry.employeeName,
        date: entry.date,
        categories: [...entry.categories].sort(),
      });
    }
  }
  return collisions.sort(
    (left, right) => left.employeeHrId.localeCompare(right.employeeHrId) || left.date.localeCompare(right.date),
  );
}

export class DeductionsConflictError extends Error {
  public readonly code = "DEDUCTIONS_CONFLICT" as const;
  public readonly overlappingDates: string[];

  constructor(overlappingDates: string[]) {
    super(`Deduction candidate conflicts with an existing entry on dates: ${overlappingDates.join(", ")}`);
    this.name = "DeductionsConflictError";
    this.overlappingDates = [...overlappingDates];
  }
}
