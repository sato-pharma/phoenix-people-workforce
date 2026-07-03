// Weekly digest builder — composes the reconciliation gating and the
// flexible-hours engine into a settlement-week digest for one employee.
//
// The `buildEmployeeWeekDigest` function is pure so the whole composition
// (gating → engine → EGP value → week totals) is unit-testable without a DB.
// The DB-backed generator (fetch + persist) wraps this pure core.

import {
  evaluateFlexibleHoursDay,
  type DeductionBracket,
  type FlexibleHoursConfig,
  type FlexibleHoursStatus,
} from "@/lib/attendance/flexible-hours";
import { reconcileDay, type ReconcileInput } from "@/lib/attendance/digest-reconcile";

/** Deductions are salary-only; a day is worth (monthly salary ÷ 30). */
export const ATTENDANCE_SALARY_DIVISOR = 30;

export type DigestDayInput = {
  dateIso: string;
  reconcile: ReconcileInput;
  firstPunchMinutes: number | null;
  lastPunchMinutes: number | null;
  visiblePunchCount: number;
  config: FlexibleHoursConfig;
  lateBrackets: DeductionBracket[];
  shortBrackets: DeductionBracket[];
};

export type DigestLineStatus = "late" | "short_hours" | "missing_punch";

export type DigestLineDraft = {
  dateIso: string;
  status: DigestLineStatus;
  lateMinutes: number;
  shortMinutes: number;
  workedMinutes: number;
  deductionDays: number;
  deductionValue: number;
  reason: string;
};

export type DigestFlag = {
  dateIso: string;
  flagType: "office_no_show" | "field_punch_anomaly";
  reason: string;
};

export type EmployeeWeekDigest = {
  lines: DigestLineDraft[];
  flags: DigestFlag[];
  totalDeductionDays: number;
  totalDeductionValue: number;
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** EGP value of a deduction: (monthly salary ÷ 30) × days, rounded to 2 dp. */
export function deductionValueEgp(baseSalary: number | null | undefined, deductionDays: number): number {
  const salary = Number(baseSalary);
  if (!Number.isFinite(salary) || salary <= 0 || deductionDays <= 0) return 0;
  return round2((salary / ATTENDANCE_SALARY_DIVISOR) * deductionDays);
}

function toLineStatus(status: FlexibleHoursStatus): DigestLineStatus {
  if (status === "Missing punch") return "missing_punch";
  if (status === "Late") return "late";
  return "short_hours";
}

/**
 * Build one employee's digest for a settlement week from per-day inputs.
 * Days that reconcile to "skip" or "Complete" produce nothing; "flag" days go to
 * `flags`; everything else becomes a deductible (or missing-punch) line.
 */
export function buildEmployeeWeekDigest(input: {
  baseSalary: number | null;
  days: DigestDayInput[];
}): EmployeeWeekDigest {
  const lines: DigestLineDraft[] = [];
  const flags: DigestFlag[] = [];

  for (const day of input.days) {
    const decision = reconcileDay(day.reconcile);
    if (decision.action === "skip") continue;
    if (decision.action === "flag") {
      flags.push({ dateIso: day.dateIso, flagType: decision.flagType, reason: decision.reason });
      continue;
    }

    const result = evaluateFlexibleHoursDay({
      firstPunchMinutes: day.firstPunchMinutes,
      lastPunchMinutes: day.lastPunchMinutes,
      visiblePunchCount: day.visiblePunchCount,
      config: day.config,
      lateBrackets: day.lateBrackets,
      shortBrackets: day.shortBrackets,
    });

    // A fully complete day owes nothing. Missing-punch and any deduction become
    // a line (missing-punch carries 0 days — it awaits the A-13 → HR → COO chain).
    if (result.status === "Complete") continue;

    lines.push({
      dateIso: day.dateIso,
      status: toLineStatus(result.status),
      lateMinutes: result.lateMinutes,
      shortMinutes: result.shortMinutes,
      workedMinutes: result.workedMinutes,
      deductionDays: result.deductionDays,
      deductionValue: deductionValueEgp(input.baseSalary, result.deductionDays),
      reason: result.reason,
    });
  }

  return {
    lines,
    flags,
    totalDeductionDays: round3(lines.reduce((sum, line) => sum + line.deductionDays, 0)),
    totalDeductionValue: round2(lines.reduce((sum, line) => sum + line.deductionValue, 0)),
  };
}
