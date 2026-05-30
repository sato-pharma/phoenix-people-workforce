// Deductions Governance Center: pure conflict-detection helpers.
// No DB I/O. No payroll/leave mutation.

import { canonicalHrIdKey } from "../hr-id.ts";
import { normalizeMonthKey } from "./candidate-key.ts";
import type { DeductionType } from "./types.ts";

export function findDateOverlap(
  a: readonly string[],
  b: readonly string[],
): string[] {
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

export type CandidateConflictResult = {
  conflicts: boolean;
  overlappingDates: string[];
  reason: string | null;
};

type ConflictCandidate = {
  employeeCode: string;
  monthKey: string;
  deductionType: DeductionType;
  dates: readonly string[];
};

export function detectCandidateConflict(
  a: ConflictCandidate,
  b: ConflictCandidate,
): CandidateConflictResult {
  const aHr = canonicalHrIdKey(a.employeeCode);
  const bHr = canonicalHrIdKey(b.employeeCode);
  if (!aHr || !bHr || aHr !== bHr) {
    return {
      conflicts: false,
      overlappingDates: [],
      reason: null,
    };
  }

  let aMonth: string;
  let bMonth: string;
  try {
    aMonth = normalizeMonthKey(a.monthKey);
    bMonth = normalizeMonthKey(b.monthKey);
  } catch {
    return {
      conflicts: false,
      overlappingDates: [],
      reason: null,
    };
  }
  if (aMonth !== bMonth) {
    return {
      conflicts: false,
      overlappingDates: [],
      reason: null,
    };
  }

  if (a.deductionType !== b.deductionType) {
    return {
      conflicts: false,
      overlappingDates: [],
      reason: null,
    };
  }

  const overlappingDates = findDateOverlap(a.dates, b.dates);
  if (overlappingDates.length === 0) {
    return {
      conflicts: false,
      overlappingDates: [],
      reason: null,
    };
  }

  return {
    conflicts: true,
    overlappingDates,
    reason: `Same employee, month, and deduction type with overlapping dates (${overlappingDates.join(", ")})`,
  };
}

export class DeductionConflictError extends Error {
  public readonly code = "DEDUCTION_CONFLICT" as const;
  public readonly overlappingDates: string[];

  constructor(overlappingDates: string[]) {
    super(
      `Deduction candidate conflicts with an existing entry on dates: ${overlappingDates.join(", ")}`,
    );
    this.name = "DeductionConflictError";
    this.overlappingDates = [...overlappingDates];
  }
}
