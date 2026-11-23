// Daily Deductions: DEDUCT A DAY BY HAND — choose a person, choose a day, read what Phoenix holds for
// that day, then push a deduction for it with a comment the employee reads. Pure: no I/O, no clock —
// the server half is day-review-service.ts.
//
// THE OWNER'S REQUEST (2026-11-23): "I want to be able to choose a person and choose a date. It doesn't
// have to be the system identifying ... his activity record for this day appear to me. Then I can push
// deduction for this day to a person with a comment shown to him, and this if approved to payroll, then
// it is deduction to be added to the payroll."
//
// HOW IT REACHES PAYROLL. A pushed day is ONE month-module candidate (deductions_candidates), category
// `other`, one day or half a day, dated on the day itself and keyed to the payroll month that day is
// charged to (`dayChargeTarget`, so a one-part employee's 22nd onward lands on the next payroll month,
// exactly where the collection run would put it). It is born "Pending" — the employee sees it at once on
// his own Deductions page as "Under review", with the comment as its reason — and payroll charges it only
// once it is "Approved for Payroll" on the Deductions screen, like every other category that needs an
// approval (`other` does).
//
// 🔴 IT CLAIMS ITS DAY. Unlike a Loan / Other entry typed on the Deductions screen (source `manual_hr`,
// dated on the month's 1st as a placeholder), this row names a REAL day, so the publish-time day guard
// (`findDayCollisions`, and the database trigger on the publication lines) treats it like any other day.
// That is why a push is refused while another live deduction already charges the same person that day:
// the guard would refuse the second one at payroll anyway, and refusing here says so while the screen is
// still open.

import { calculateDeductionAmountFromBaseSalary, resolveAppliedDeductionDates } from "@/lib/deductions/calculations.ts";
import type { DeductionCycleEvidence } from "@/lib/deductions/cycle.ts";
import type { DeductionsCandidateDraft, DeductionsCategory } from "@/lib/deductions/types.ts";

/** The source system every pushed day carries — what tells it apart from a Loan / Other placeholder. */
export const DAY_REVIEW_SOURCE_SYSTEM = "daily_day_review";

/** The category a pushed day is charged under. Approval-required, paid through Other deductions. */
export const DAY_REVIEW_CATEGORY = "other" satisfies DeductionsCategory;

/** The two sizes a pushed day may be. */
export const DAY_REVIEW_FRACTIONS = [1, 0.5] as const;
export type DayReviewFraction = (typeof DAY_REVIEW_FRACTIONS)[number];

/** The longest comment the employee is shown. Long enough for a paragraph, short enough for an email. */
export const DAY_REVIEW_COMMENT_MAX = 1000;

export function isDayReviewFraction(value: unknown): value is DayReviewFraction {
  return value === 1 || value === 0.5;
}

/** "1 day" / "Half a day" — how the screen and the reason name the size. */
export function dayReviewFractionLabel(fraction: DayReviewFraction): string {
  return fraction === 0.5 ? "Half a day" : "1 day";
}

/** The comment as it is stored: trimmed, inner runs of spaces kept as typed, nothing else changed. */
export function tidyDayReviewComment(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * One day's price: Base ÷ the actual calendar days of THAT DAY'S month × the fraction — the owner's
 * standing day-rate rule, through the one helper every category prices a day with. Priced on the day's
 * own calendar month, as the Employee Day Report and the connectors price the same day. Null when no
 * base salary is on record: the screen must say so, never offer a 0.00 deduction.
 */
export function priceDayReview(input: { baseSalary: number | null | undefined; date: string; fraction: DayReviewFraction }): number | null {
  const year = Number(input.date.slice(0, 4));
  const month = Number(input.date.slice(5, 7));
  return calculateDeductionAmountFromBaseSalary({ baseSalary: input.baseSalary, deductionDays: input.fraction, month, year });
}

/** A live deduction already on the chosen day, in the words the screen shows. */
export type DayChargeOnRecord = {
  candidateId: string;
  category: DeductionsCategory;
  sourceSystem: string;
  monthKey: string;
  decisionStatus: string;
  /** The amount the row charges or would charge, when it can be read. */
  amount: number | null;
  /** True for a pushed day of this screen. */
  isDayReview: boolean;
};

type ChargeRow = {
  id: string;
  category: DeductionsCategory;
  sourceSystem: string;
  monthKey: string;
  dates: readonly string[];
  estimatedAmount?: number | null;
  supersededAt?: string | null;
  decision?: {
    decisionStatus?: string | null;
    appliedDates?: readonly string[] | null;
    appliedAmount?: number | null;
  } | null;
};

/**
 * Every live deduction that charges `date` for the person — the rows a push for that day would
 * double-charge. Three rows never count:
 *   - a retired (superseded) row — the module no longer stands behind it;
 *   - a row marked "Do Not Take Action", or one whose reviewer unticked that day — it charges nothing
 *     there;
 *   - a Loan / Other entry typed on the Deductions screen (`manual_hr`): its date is the month's 1st as a
 *     placeholder, never a day the employee was absent (the publish guard skips it the same way).
 */
export function chargesOnDay(rows: readonly ChargeRow[], date: string): DayChargeOnRecord[] {
  const out: DayChargeOnRecord[] = [];
  for (const row of rows) {
    if (row.supersededAt) continue;
    if (row.sourceSystem === "manual_hr") continue;
    const status = String(row.decision?.decisionStatus ?? "").trim() || "Pending";
    if (status === "Do Not Take Action") continue;
    const charged = resolveAppliedDeductionDates({ dates: row.dates, decision: row.decision ?? null });
    if (!charged.includes(date)) continue;
    out.push({
      candidateId: row.id,
      category: row.category,
      sourceSystem: row.sourceSystem,
      monthKey: row.monthKey,
      decisionStatus: status,
      amount: row.decision?.appliedAmount ?? row.estimatedAmount ?? null,
      isDayReview: row.sourceSystem === DAY_REVIEW_SOURCE_SYSTEM,
    });
  }
  return out;
}

/** What the push needs to know about the person, read from the employees table on the server. */
export type DayReviewEmployee = {
  hrId: string;
  /** The name as stored — a payroll row keeps the full name (the display name is for screens). */
  fullName: string | null;
  baseSalary: number | null;
  hireDate: string | null;
  lastWorkingDate: string | null;
  /** True when the employment status is a terminal one (resigned, terminated...). */
  hasLeft: boolean;
};

/**
 * Why a day cannot be deducted for this person, or null when it can. Checked before anything is
 * written, and again by the server on every push — the screen's own copy is a courtesy.
 */
export function dayReviewRefusal(input: { employee: DayReviewEmployee; date: string; todayIso: string }): string | null {
  const { employee, date, todayIso } = input;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Choose a day.";
  if (date > todayIso) return "That day has not come yet. A day can be deducted only once it has started.";
  if (employee.hireDate && date < employee.hireDate) {
    return `That day is before ${employee.fullName ?? "this employee"} joined (${employee.hireDate}).`;
  }
  if (employee.hasLeft) {
    if (!employee.lastWorkingDate) {
      return `${employee.fullName ?? "This employee"} has left and no last working day is recorded, so no day of theirs can be deducted here.`;
    }
    if (date > employee.lastWorkingDate) {
      return `That day is after ${employee.fullName ?? "this employee"}'s last working day (${employee.lastWorkingDate}).`;
    }
  }
  return null;
}

/**
 * The one candidate a push writes. Deterministic: the same person and day always build the same key,
 * so a double click — or a second push for a day already pushed — collides on the
 * (category, candidate_key) index and is reported, never written twice.
 */
export function buildDayReviewDraft(input: {
  employee: DayReviewEmployee;
  date: string;
  fraction: DayReviewFraction;
  comment: string;
  enteredBy: string;
  charge: { monthKey: string; month: number; year: number; cycleEvidence: DeductionCycleEvidence | null };
}): DeductionsCandidateDraft {
  const comment = tidyDayReviewComment(input.comment);
  if (!comment) throw new Error("Validation: write the comment the employee will read.");
  if (comment.length > DAY_REVIEW_COMMENT_MAX) {
    throw new Error(`Validation: the comment is ${comment.length} characters; keep it to ${DAY_REVIEW_COMMENT_MAX}.`);
  }
  if (!isDayReviewFraction(input.fraction)) throw new Error("Validation: a day is deducted as 1 day or half a day.");
  if (!input.employee.hrId.trim()) throw new Error("Validation: choose an employee.");

  const estimatedAmount = priceDayReview({ baseSalary: input.employee.baseSalary, date: input.date, fraction: input.fraction });
  return {
    category: DAY_REVIEW_CATEGORY,
    sourceSystem: DAY_REVIEW_SOURCE_SYSTEM,
    // One per person per day. The comment and the size are deliberately NOT in the identity: a second
    // push for the same day is the same deduction, and is refused rather than charged twice.
    sourceRecordId: `day-review:${input.employee.hrId.trim()}:${input.date}`,
    employeeHrId: input.employee.hrId.trim(),
    employeeName: input.employee.fullName,
    monthKey: input.charge.monthKey,
    month: input.charge.month,
    year: input.charge.year,
    unit: "days",
    rawValue: input.fraction,
    estimatedAmount,
    calculationStatus: estimatedAmount != null ? "calculated" : "requires_review",
    severity: "Medium",
    // The reason IS the comment: it is what the employee's Deductions page shows under "why".
    reason: comment,
    evidence: {
      enteredBy: input.enteredBy,
      pushedFrom: "daily_deductions_day_review",
      deductionDate: input.date,
      dayFraction: input.fraction,
      ...(input.charge.cycleEvidence ? { deductionCycle: input.charge.cycleEvidence } : {}),
    },
    dates: [input.date],
  };
}
