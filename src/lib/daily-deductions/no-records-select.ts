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
//
// And one day is charged at HALF: a day nothing but interviews covers, exactly one half of it
// (owner, 2026-11-18: two or more interviews in a half are that half worked). The Half Day (CRM)
// tab charges the other half for reps and district managers; for everyone this connector owns, it
// is charged here at 0.5 — before this, every reader dropped the day and nobody charged it.

import { logsOwnCrmVisitsTitle, isSfeManagerTitle } from "@/lib/field-workforce-compliance/eligibility.ts";
import { canonicalHrIdKey } from "@/lib/hr-id.ts";
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { compactDeductionsHrId } from "@/lib/deductions/candidate-key.ts";
import type { DeductionsCandidateDraft } from "@/lib/deductions/types.ts";

const DISTRICT_MANAGER_TITLE = /district\s+(sales\s+)?manager/i;

/** One "No Activity Recorded" day, as the Private Calendar engine reports it. */
export type NoRecordsDay = {
  /** Nothing but interviews covers the day (getCompanyNoActivityDays `interviewHalfDays`). */
  coveredOnlyByInterviews?: boolean;
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
  /**
   * `${compact}:${date}` for every day another source PROVES was worked. Never charged.
   *
   * Two of them, and this engine sees neither. The Private Calendar reads field visits through the
   * CRM door, whose Phoenix branches serve only a team the Super Admin has pressed Start on — so a
   * person on an unstarted team who logged real visits arrives here as "No Activity Recorded". And
   * nothing upstream reads the outstation trip tables, so a day spent travelling on company
   * business, with no doctor to visit and no office device to punch, arrives the same way.
   * See src/lib/deductions/proven-worked-days.ts.
   */
  provenWorkedDayKeys: ReadonlySet<string>;
  /**
   * `${compact}:${date}` -> the half his interviews cover, on a day only one half of which they cover
   * and nothing else proves (`ProvenWorkedDays.interviewHalfOnly`). Such a day, when nothing but the
   * interviews covers it, is charged its other half: 0.5.
   */
  interviewHalfOnly?: ReadonlyMap<string, "AM" | "PM">;
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
    const provenKey = compactKey ? `${compactKey}:${day.date}` : null;
    // A day only interviews cover is charged ONLY when the interview fold agrees they hold exactly one
    // half — the whole day covered, or any doubt, is never charged.
    const interviewHalf = day.coveredOnlyByInterviews && provenKey ? input.interviewHalfOnly?.get(provenKey) : undefined;
    if (day.coveredOnlyByInterviews && !interviewHalf) continue;
    // A day another source proves was worked is never charged. Keyed compact, like the salary map.
    if (!interviewHalf && provenKey && input.provenWorkedDayKeys.has(provenKey)) continue;
    const deductionDays = interviewHalf ? 0.5 : 1;
    const baseSalary = compactKey ? (input.baseSalaryByCompact.get(compactKey) ?? null) : null;
    const estimatedAmount = calculateDeductionAmountFromBaseSalary({
      baseSalary,
      deductionDays,
      month: input.month,
      year: input.year,
    });
    if (estimatedAmount == null) continue;
    const worked = interviewHalf === "AM" ? "morning" : "afternoon";
    const owed = interviewHalf === "AM" ? "afternoon" : "morning";

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
      rawValue: deductionDays,
      estimatedAmount,
      calculationStatus: "calculated" as const,
      reason: interviewHalf
        ? `Interviews in the ${worked} only — nothing recorded for the ${owed}: no punch, visit, approved vacation or excuse`
        : day.description || "No records — no punch and no other activity recorded",
      evidence: interviewHalf
        ? { description: day.description, interviewsCoveredHalf: interviewHalf, deductionDays }
        : { description: day.description },
      dates: [day.date],
    } satisfies DeductionsCandidateDraft);
  }

  return drafts;
}
