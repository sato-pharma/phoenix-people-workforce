// Daily Deductions module: the PURE half of the No-records connector. No DB, no I/O —
// the loaders live in no-records.ts so this selection can be pinned by a test.
//
// A "no records" day is a working day on which an active employee left NO trace of any kind:
// no punch, no CRM visit, no leave, no excuse, no approved plan, no holiday cover. The
// Private Calendar "No Activity Recorded" engine already decides that (and already skips
// pre-hire days, holidays and non-working days); this file decides WHO a deduction can
// honestly be raised against, and WHICH of those days are trustworthy.
//
// Owner scope, 2026-10-12: "every active employee with no anything". Three groups are left out,
// each because another connector already owns the same absence and counting it twice would
// double-book the day:
//
//   1. Medical Reps — the `crm` connector is the sole deduction authority for the people who
//      log their own visits. Running both over a rep books every empty day twice.
//   2. District managers (including Senior) — the `dsm_no_record` connector owns them, behind
//      a coverage guard that stops a DSM being charged for a team CRM cannot see.
//   3. The SFE Manager — by the standing owner rule it never generates a deduction.
//
// And two days are never charged:
//
//   - A COMPANY-WIDE OUTAGE DAY (no employee has any punch). Punches reach the system late —
//     all 25 punches for 11 Oct 2026 were ingested at 13:14 on 12 Oct — so yesterday can look
//     like a device outage until the next sync. The engine reads that as "everyone absent".
//   - A person with NO BASE SALARY. A day-rate deduction is Base Salary ÷ days in month; with
//     no salary basis there is nothing to take a fraction of (the same rule the retired
//     month-module version carried).

import { logsOwnCrmVisitsTitle, isSfeManagerTitle } from "@/lib/field-workforce-compliance/eligibility.ts";
import { canonicalHrIdKey } from "@/lib/hr-id.ts";
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";

const DISTRICT_MANAGER_TITLE = /district\s+(sales\s+)?manager/i;

/** One "No Activity Recorded" day, as the Private Calendar engine reports it. */
export type NoRecordsDay = {
  date: string;
  description: string | null;
  employeeHrId: string;
  employeeName: string | null;
};

/**
 * True when another deduction connector (or an owner rule) already owns this person's
 * absence, so the no-records connector must stay out of their way.
 */
export function isOwnedByAnotherDeductionConnector(jobTitle: string | null | undefined): boolean {
  if (logsOwnCrmVisitsTitle(jobTitle)) return true;
  if (DISTRICT_MANAGER_TITLE.test(String(jobTitle ?? ""))) return true;
  if (isSfeManagerTitle(jobTitle)) return true;
  return false;
}

export function selectNoRecordsDrafts(input: {
  days: readonly NoRecordsDay[];
  /** Job title per employee, keyed by the CANONICAL hr-id key. */
  jobTitleByCanonicalKey: ReadonlyMap<string, string | null>;
  /** Dates on which no employee at all has a punch — never charged. */
  outageDates: ReadonlySet<string>;
  /** Base salary per employee, keyed by the COMPACT hr-id (hyphens stripped). */
  baseSalaryByCompact: ReadonlyMap<string, number | null>;
  month: number;
  year: number;
}): DeductionsCandidateDraft[] {
  const monthKey = `${input.year}-${String(input.month).padStart(2, "0")}`;
  const drafts: DeductionsCandidateDraft[] = [];

  for (const day of input.days) {
    if (input.outageDates.has(day.date)) continue;

    const key = canonicalHrIdKey(day.employeeHrId);
    if (key && isOwnedByAnotherDeductionConnector(input.jobTitleByCanonicalKey.get(key))) continue;

    // The salary map is keyed by the COMPACT hr-id; the canonical key would miss every lookup.
    const compactKey = compactDeductionsHrId(day.employeeHrId);
    const baseSalary = compactKey ? (input.baseSalaryByCompact.get(compactKey) ?? null) : null;
    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays: 1,
      month: input.month,
      year: input.year,
    });
    if (estimatedAmount == null) continue;

    drafts.push({
      category: "no_records_activity",
      sourceSystem: "no_activity_engine",
      sourceRecordId: `${day.employeeHrId}:${day.date}`,
      employeeHrId: day.employeeHrId,
      employeeName: day.employeeName,
      monthKey,
      month: input.month,
      year: input.year,
      unit: "days",
      rawValue: 1,
      estimatedAmount,
      calculationStatus: "calculated" as const,
      reason: day.description || "No records — no punch and no other activity recorded",
      evidence: { description: day.description },
      dates: [day.date],
    } satisfies DeductionsCandidateDraft);
  }

  return drafts;
}
