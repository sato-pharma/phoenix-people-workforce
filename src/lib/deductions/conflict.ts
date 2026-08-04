// Unified Deductions module: pure conflict-detection helpers. No DB I/O.
// Ported from deductions-governance/conflict.ts, keyed by category instead of
// deductionType so cross-category same-day overlaps (e.g. CRM vs No Records
// Activity both claiming the same day) surface too — see the mutual-exclusion
// rule the retired No Activity Days clarification flow used, generalized here.

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

/** connectors/manual.ts's sourceSystem. Its `dates` are a placeholder anchor. */
const MANUAL_ENTRY_SOURCE_SYSTEM = "manual_hr";

export type DeductionsDayCollision = {
  employeeHrId: string;
  employeeName: string | null;
  date: string;
  categories: DeductionsCategory[];
  sourceSystems: string[];
};

/**
 * Every (employee, day) claimed by MORE THAN ONE detection source in a set —
 * the double-deduction check, run across a whole month at once.
 *
 * This is the set-wide counterpart to detectCrossCategoryConflict's pairwise
 * check: publishing is an all-at-once operation, so the question that actually
 * matters is "does any day appear twice anywhere in what I'm about to pay?",
 * not "do these two specific rows clash?". O(n) over candidates rather than
 * O(n²) pairwise, which matters at ~2,000 candidates a month.
 *
 * A claim is (category, sourceSystem), NOT category alone. Unpaid Vacation is
 * found by two sources — the HR request (`vacation_balance`) and a CRM annual
 * leave record (`crm_vacation_signal`) — so the same absence produces two
 * candidates in ONE category. Keying on category alone made that invisible
 * here, and the (category, candidate_key) unique index cannot see it either
 * because only the source prefix inside the key differs. Measured on July 2026
 * production, 19 employee-days were claimed twice this way (8,822.54 EGP).
 *
 * Two candidates from the SAME category and source on one day are deliberately
 * still one claim: a genuine same-source duplicate (two overlapping approved
 * requests) is a defect in that source, to be rejected where it is entered.
 *
 * A `manual_hr` row makes NO claim on a day at all and is skipped. Its date is
 * not a detection — connectors/manual.ts anchors every manual Loan/Other entry
 * to `${monthKey}-01` as a deterministic placeholder, deliberately meaning "no
 * specific date", because HR types an amount and a reason, never a day. Reading
 * that placeholder as a real claim is a pure false positive, and widening the
 * key from category to (category, source) turned it into a live one: on
 * production 2026-07 the holiday bridge charges 2026-07-01 for one employee and
 * a manual Other entry is anchored to 2026-07-01 for another, both in category
 * `other`. Had they been the same person, the month's publish would abort with
 * "…2026-07-01 → other" — naming one category twice, and unresolvable, since
 * clearing either row deletes a legitimate deduction. Nothing is lost by
 * skipping: the gate never protected against a manual entry duplicating a
 * detected day, because the anchor never points at the day HR meant.
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
    /** Optional so an ad-hoc caller can omit it; claims that all omit it are
     *  indistinguishable and therefore count as a single claim. */
    sourceSystem?: string | null;
    dates: readonly string[];
  }>,
): DeductionsDayCollision[] {
  const seen = new Map<
    string,
    {
      employeeHrId: string;
      employeeName: string | null;
      date: string;
      claims: Map<string, { category: DeductionsCategory; sourceSystem: string }>;
    }
  >();

  for (const candidate of candidates) {
    const sourceSystem = typeof candidate.sourceSystem === "string" ? candidate.sourceSystem.trim() : "";
    // Placeholder date, not a detected day — see the note above.
    if (sourceSystem === MANUAL_ENTRY_SOURCE_SYSTEM) continue;
    const claimKey = `${candidate.category} ${sourceSystem}`;
    for (const rawDate of candidate.dates) {
      if (typeof rawDate !== "string") continue;
      const date = rawDate.trim();
      if (!date) continue;
      const key = `${candidate.employeeHrIdCompact}:${date}`;
      const entry = seen.get(key);
      if (entry) {
        entry.claims.set(claimKey, { category: candidate.category, sourceSystem });
      } else {
        seen.set(key, {
          employeeHrId: candidate.employeeHrId,
          employeeName: candidate.employeeName ?? null,
          date,
          claims: new Map([[claimKey, { category: candidate.category, sourceSystem }]]),
        });
      }
    }
  }

  const collisions: DeductionsDayCollision[] = [];
  for (const entry of seen.values()) {
    // >1 claim means two independent detections would each charge this day.
    if (entry.claims.size > 1) {
      const claims = [...entry.claims.values()];
      collisions.push({
        employeeHrId: entry.employeeHrId,
        employeeName: entry.employeeName,
        date: entry.date,
        categories: [...new Set(claims.map((claim) => claim.category))].sort(),
        sourceSystems: [...new Set(claims.map((claim) => claim.sourceSystem).filter(Boolean))].sort(),
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
