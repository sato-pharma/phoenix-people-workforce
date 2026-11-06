// Unified Deductions module: pure calculation helpers. No DB I/O.
// Ported from deductions-governance/calculations.ts.

import { sumDetectedDeductionDayWeights } from "@/lib/field-workforce-compliance/weekend-policy.ts";
import { calendarDaysInMonth } from "@/lib/payroll/copilot/proration.ts";
import { deductionsCalculationStatuses, deductionsUnits } from "./types.ts";
import type {
  DeductionsCalculationStatus,
  DeductionsCategory,
  DeductionsCategoryConfig,
  DeductionsSalaryRecordsColumn,
  DeductionsUnit,
} from "./types.ts";

// Static mirror of the deductions_categories seed rows (20260725115137_deductions_module.sql).
// Kept as a pure, synchronous lookup — same convention the legacy module used for
// payrollColumnForDeduction — so calculation code never needs an async DB round-trip.
// The DB table remains the source of truth for anything DB-joined or UI-displayed;
// if these two ever drift, the DB wins and this constant should be updated to match.
export const DEDUCTIONS_CATEGORY_CONFIG: Record<DeductionsCategory, DeductionsCategoryConfig> = {
  fingerprint: {
    category: "fingerprint",
    label: "Fingerprint",
    detectionEngine: "fingerprint_report",
    requiresApproval: true,
    salaryRecordsColumn: "finger_print",
    sortOrder: 1,
  },
  crm: {
    category: "crm",
    label: "CRM",
    detectionEngine: "crm_visits_mirror",
    // Owner's existing dictated rule: "whoever has N days must be deducted" —
    // a field rep's no-CRM-activity day is deducted by default unless HR
    // explicitly clears it. Every other category requires an explicit approval.
    requiresApproval: false,
    salaryRecordsColumn: "crm",
    sortOrder: 2,
  },
  // Owner, 2026-10-08: a half day a district manager or rep left unaccounted for
  // (connectors/half-day.ts). Deliberately NOT mandatory like `crm` — "you decide
  // each": nothing is charged until the row is approved. Paid through the CRM
  // column, so an approved half day reaches the same payroll step as a CRM day.
  // Sorted beside CRM; the categories after it moved down one
  // (20261008200000_deductions_crm_half_day_category.sql).
  crm_half_day: {
    category: "crm_half_day",
    label: "Half Day (CRM)",
    detectionEngine: "crm_half_day",
    requiresApproval: true,
    salaryRecordsColumn: "crm",
    sortOrder: 3,
  },
  no_records_activity: {
    category: "no_records_activity",
    label: "No Records Activity",
    detectionEngine: "no_activity_engine",
    requiresApproval: true,
    salaryRecordsColumn: "other_deductions",
    sortOrder: 4,
  },
  unpaid_vacation: {
    category: "unpaid_vacation",
    label: "Unpaid Vacation",
    detectionEngine: "vacation_balance",
    requiresApproval: true,
    salaryRecordsColumn: "unpaid_vacations",
    sortOrder: 5,
  },
  insufficient_balance_vacation: {
    category: "insufficient_balance_vacation",
    label: "Insufficient Balance Vacation",
    detectionEngine: "vacation_balance",
    requiresApproval: true,
    salaryRecordsColumn: "unpaid_vacations",
    sortOrder: 6,
  },
  loan: {
    category: "loan",
    label: "Loan",
    detectionEngine: "manual_hr",
    requiresApproval: true,
    salaryRecordsColumn: "loans",
    sortOrder: 7,
  },
  other: {
    category: "other",
    label: "Other",
    detectionEngine: "manual_hr",
    requiresApproval: true,
    salaryRecordsColumn: "other_deductions",
    sortOrder: 8,
  },
  // Owner, 2026-10-12: a head-office week with no weekly plan submitted by that Monday — one day,
  // charged on the Monday. A DAILY-module connector only: it is deliberately absent from
  // DEDUCTION_COLLECTORS, so the month scan never writes it, and nothing is charged until the Super
  // Admin releases the line. Mirrors 20261012120000_deductions_no_weekly_plan_category.sql.
  no_weekly_plan: {
    category: "no_weekly_plan",
    label: "No Weekly Plan",
    detectionEngine: "weekly_plan_submission",
    requiresApproval: true,
    salaryRecordsColumn: "other_deductions",
    sortOrder: 9,
  },
  // Owner, 2026-10-20: a field day the Super Admin decided in the HR operations report. Written only
  // by src/lib/hr-ops-reports/bridge.ts, beside the day it adds to the weekly attendance review, and
  // decided by that review's answer through digest-bridge.ts — so nothing is charged until the
  // employee has answered (or the answer deadline settles it to salary). Paid through the CRM column,
  // like crm and crm_half_day. Mirrors 20261020072217_hr_ops_bridge_field_review.sql.
  field_review: {
    category: "field_review",
    label: "Field Day (Reviewed)",
    detectionEngine: "hr_ops_report",
    requiresApproval: true,
    salaryRecordsColumn: "crm",
    sortOrder: 10,
  },
};

export function deductionsCategoryLabel(category: DeductionsCategory): string {
  return DEDUCTIONS_CATEGORY_CONFIG[category].label;
}

/**
 * The two enums a reader meets on a deduction export, in words.
 *
 * The detail sheets printed the stored values — `days`, `requires_review` — straight out of the
 * database, beside columns already written for a person. That is the same defect as a raw HR code
 * on a screen: it reads as a table dump rather than a document, and `requires_review` is precisely
 * the row a reviewer most needs to notice.
 *
 * `sourceSystem` is deliberately NOT here. Its values — `crm_visits_mirror`, `holiday_bridge`,
 * `fingerprint_report` — are provenance identifiers, and an audit reader wants the exact string
 * that was recorded. Prettifying an identifier is how a workbook stops being traceable back to
 * whatever produced it.
 *
 * DECISION STATUS is not here either, and needs no helper: `deductionsDecisionStatuses` is already
 * written in words ("Approved for Payroll", "Do Not Take Action"). A pass-through map for it would
 * only be a second place to keep the same strings in step.
 */
const DEDUCTIONS_UNIT_LABELS: Record<DeductionsUnit, string> = {
  amount: "Amount",
  days: "Days",
};

const DEDUCTIONS_CALCULATION_STATUS_LABELS: Record<DeductionsCalculationStatus, string> = {
  calculated: "Calculated",
  requires_review: "Requires review",
};

/** "Days" / "Amount" — what this row's `rawValue` is counted in. */
export function deductionsUnitLabel(unit: DeductionsUnit): string {
  return DEDUCTIONS_UNIT_LABELS[unit] ?? unit;
}

/** "Calculated" / "Requires review" — whether the amount could be worked out. */
export function deductionsCalculationStatusLabel(status: DeductionsCalculationStatus): string {
  return DEDUCTIONS_CALCULATION_STATUS_LABELS[status] ?? status;
}

/**
 * Every enum member has a label.
 *
 * An exhaustive `Record` does NOT gate the build here — `ignoreBuildErrors` lets a missing key
 * compile, build and deploy, and the cell would then print `undefined` on a payroll document. The
 * `??` fallbacks above stop that being blank; this stops it shipping at all. Called by the
 * registered test, never at import time: a missing label is a developer error, and throwing on
 * import would take down the deductions module in production over it.
 */
export function assertEveryDeductionsEnumIsLabelled(): void {
  for (const unit of deductionsUnits) {
    if (!DEDUCTIONS_UNIT_LABELS[unit]) throw new Error(`Deductions unit "${unit}" has no label.`);
  }
  for (const status of deductionsCalculationStatuses) {
    if (!DEDUCTIONS_CALCULATION_STATUS_LABELS[status]) {
      throw new Error(`Deductions calculation status "${status}" has no label.`);
    }
  }
}

export function deductionsCategoryRequiresApproval(category: DeductionsCategory): boolean {
  return DEDUCTIONS_CATEGORY_CONFIG[category].requiresApproval;
}

export function salaryRecordsColumnForCategory(category: DeductionsCategory): DeductionsSalaryRecordsColumn | null {
  return DEDUCTIONS_CATEGORY_CONFIG[category].salaryRecordsColumn;
}

/**
 * Mandatory categories (currently only crm) publish unless the Super Admin
 * explicitly cleared the day ("Do Not Take Action"); every other category
 * publishes only once explicitly "Approved for Payroll". A candidate with no
 * decision row yet defaults to "Pending", which only a mandatory category
 * survives.
 *
 * Owner rule (2026-07-25): a deduction the Super Admin confirmed IS applied in
 * that month's payroll. An employee dispute flags it for attention but never
 * silently changes the money — only the Super Admin marking it back to
 * "Do Not Take Action" withholds it. Hence Disputed/Needs Follow-up remain
 * publishable for mandatory categories.
 *
 * Lives here rather than in publish.ts so service.ts's Overview totals can
 * apply the identical rule without a circular import (service.ts <- publish.ts).
 * The two disagreeing is exactly how HR ended up reading a number ~3x larger
 * than what publish would actually commit.
 */
/**
 * Sources whose candidates always need an explicit "Approved for Payroll",
 * whatever their category's own rule says. A category cannot express this on its
 * own: these rows deliberately live in a mandatory category so reviewers find
 * them in the right place, and the safety property has to travel with the SOURCE
 * instead.
 */
const ALWAYS_REQUIRE_APPROVAL_SOURCE_SYSTEMS = new Set<string>(["dsm_no_record"]);

export function isEligibleForPublish(candidate: {
  category: DeductionsCategory;
  sourceSystem?: string | null;
  decision?: { decisionStatus?: string | null } | null;
}): boolean {
  const status = candidate.decision?.decisionStatus ?? "Pending";
  // Owner's instruction (2026-08-03): district-manager no-record days are NEVER
  // auto-published. They sit in the CRM tab so a reviewer finds them beside the
  // reps' days, but CRM is mandatory-unless-cleared — inheriting that would mean
  // a brand-new rule, applied to a population that was excluded after a
  // 131,741.94 EGP incident, publishing itself with nobody having looked. The
  // source system rather than the category decides, so the reps' long-standing
  // mandatory behaviour is untouched.
  if (ALWAYS_REQUIRE_APPROVAL_SOURCE_SYSTEMS.has(String(candidate.sourceSystem ?? ""))) {
    return status === "Approved for Payroll";
  }
  if (!deductionsCategoryRequiresApproval(candidate.category)) {
    return status !== "Do Not Take Action";
  }
  return status === "Approved for Payroll";
}

/**
 * Owner rule (2026-07-25, corrected — supersedes an earlier same-day ÷30
 * decision): a deduction's day-rate is `Base Salary ÷ actual calendar days in
 * that month`, matching the proration engine's own universal principle
 * (payroll/copilot/proration.ts) rather than a flat 30. Reuses
 * `calendarDaysInMonth` directly so the two can never drift apart again —
 * that drift (proration divides by real days, deductions divided by a flat
 * 30) is exactly what triggered this correction.
 *
 * month/year are therefore required, not optional: unlike a flat 30, the
 * divisor genuinely depends on which month the deduction falls in (28-31).
 */
export function calculateDeductionAmountFromBaseSalary(input: {
  baseSalary: number | null | undefined;
  deductionDays: number;
  month: number;
  year: number;
}) {
  const baseSalary = Number(input.baseSalary ?? 0);
  const deductionDays = Number(input.deductionDays ?? 0);
  if (!Number.isFinite(baseSalary) || baseSalary <= 0) return null;
  if (!Number.isFinite(deductionDays) || deductionDays < 0) return null;
  const daysInMonth = calendarDaysInMonth({ month: input.month, year: input.year });
  if (!Number.isFinite(daysInMonth) || daysInMonth <= 0) return null;
  return Math.round((baseSalary / daysInMonth) * deductionDays * 100) / 100;
}

/**
 * The days a candidate ACTUALLY charges: the reviewer's narrowed selection when
 * one exists, otherwise every day the detection engine found.
 *
 * `appliedDates === null` and `appliedDates === []` mean opposite things — see
 * the column comment on deductions_decisions.applied_dates. The tempting
 * shorthand here is an EMPTINESS check (`!selected?.length`, `selected?.length
 * ? selected : candidate.dates`), and it is wrong: it reads "the reviewer
 * cleared every day" as "charge every day", turning a deliberate zero into a
 * full-month deduction. Only null means "never narrowed", so this tests for
 * null and nothing else.
 */
export function resolveAppliedDeductionDates(candidate: {
  dates: readonly string[];
  decision?: { appliedDates?: readonly string[] | null } | null;
}): string[] {
  const selected = candidate.decision?.appliedDates;
  if (selected == null) return [...candidate.dates];
  return [...selected];
}

/**
 * The value this candidate PUBLISHES for: the reviewer's edited day count when
 * they typed one (`decision.appliedValue`), otherwise every detected day
 * (`rawValue`). This is publishMonth's own fallback (see publish.ts), extracted
 * here so the exports show the SAME figure publish commits.
 *
 * The defect this closes: the category XLSX printed the raw `decision.appliedValue`
 * with no fallback, so a deduction approved WITHOUT narrowing days — which leaves
 * appliedValue null — showed a blank "Applied Value" even though the full detected
 * value is exactly what publish charges.
 */
export function resolvePublishedAppliedValue(candidate: {
  rawValue: number;
  decision?: { appliedValue?: number | null } | null;
}): number {
  return candidate.decision?.appliedValue ?? candidate.rawValue;
}

/**
 * The amount this candidate PUBLISHES: the decided amount when one was set
 * (`decision.appliedAmount`), otherwise the candidate's own estimate. `null`
 * only when neither exists — the row publishMonth refuses rather than paying
 * 0.00, so a null here is "requires review", never a legitimate zero. Same
 * fallback as publishMonth's resolveAppliedAmount, extracted for the exports.
 */
export function resolvePublishedAppliedAmount(candidate: {
  estimatedAmount: number | null;
  decision?: { appliedAmount?: number | null } | null;
}): number | null {
  return candidate.decision?.appliedAmount ?? candidate.estimatedAmount ?? null;
}

export type NormalizedAppliedDates = {
  /** The accepted subset, de-duplicated and sorted. */
  dates: string[];
  /** Anything the caller sent that the detection engine never found. */
  rejected: string[];
};

/**
 * Constrains a reviewer's day selection to days the engine actually detected.
 *
 * A reviewer can only ever REMOVE days, never invent them: a deduction is
 * evidence-backed, and a day nobody detected has no evidence behind it. The
 * rejected days are returned rather than silently dropped so the caller can
 * refuse loudly — a selection that silently shrinks is how a reviewer ends up
 * believing they charged a day they did not.
 */
export function normalizeAppliedDeductionDates(input: {
  candidateDates: readonly string[];
  selected: readonly unknown[];
}): NormalizedAppliedDates {
  const detected = new Set<string>();
  for (const value of input.candidateDates) {
    if (typeof value === "string" && value.trim()) detected.add(value.trim());
  }

  const accepted = new Set<string>();
  const rejected: string[] = [];
  for (const value of input.selected) {
    if (typeof value !== "string") {
      rejected.push(String(value));
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (detected.has(trimmed)) accepted.add(trimmed);
    else rejected.push(trimmed);
  }

  return { dates: [...accepted].sort(), rejected };
}

/**
 * The DAYS a reviewer's ticked dates charge.
 *
 * A ticked date is NOT always one day: a CRM half day is `rawValue` 0.5 on a single date, and so is
 * a fingerprint half day. Counting ticks as days offered 1 day on a 0.5-day finding and the editor
 * then refused it as "more than detected". So a SINGLE-date candidate charges its own value when
 * ticked and 0 when not.
 *
 * Every other candidate keeps the tick count, and its refusal when that exceeds what was detected.
 * Its dates do not all weigh the same, so a pro-rata across them is a guess: a vacation row's
 * `dates` lists every CALENDAR day of the request, Fridays included, while `rawValue` is the unpaid
 * WORKING days. On a 3-day request over 5 dates, unticking the Friday and Saturday would read 1.8
 * days where 3 is right, and unticking a working day he came back for would read 2.4 where 2 is
 * right (risk review, 2026-10-08). For a count-based candidate
 * (rawValue === dates, every full-day CRM row) the count is exact anyway.
 */
export function daysForTickedDates(input: { rawValue: number; detectedDates: number; tickedDates: number }): number {
  const rawValue = Number(input.rawValue);
  if (input.detectedDates === 1 && Number.isFinite(rawValue)) return input.tickedDates >= 1 ? rawValue : 0;
  return input.tickedDates;
}

/**
 * A day-based candidate's amount for an arbitrary number of charged days,
 * scaled from the candidate's OWN estimate rather than from a fresh base-salary
 * read.
 *
 * Deliberate: `estimatedAmount` was computed by the connector from the employee's
 * base salary at collection time, and it is the figure publish already pays and
 * the reviewer already sees on screen. Re-reading base salary here would make a
 * row jump because payroll changed that employee's salary last week — a movement
 * the reviewer did not cause and cannot explain from the day they just unticked.
 * Scaling the candidate's own number keeps "what I see" and "what is charged"
 * the same statement.
 *
 * Returns null when there is no basis to scale (no estimate, or a candidate that
 * charges zero days), which callers must surface as "requires review" rather than
 * as 0.00 EGP.
 */
export function scaleDeductionAmountToDays(input: {
  estimatedAmount: number | null | undefined;
  rawValue: number;
  appliedDays: number;
}): number | null {
  const estimatedAmount = input.estimatedAmount;
  if (estimatedAmount == null || !Number.isFinite(estimatedAmount)) return null;
  const rawValue = Number(input.rawValue);
  const appliedDays = Number(input.appliedDays);
  if (!Number.isFinite(rawValue) || rawValue <= 0) return null;
  if (!Number.isFinite(appliedDays) || appliedDays < 0) return null;
  // Exact passthrough when nothing was narrowed, so an untouched candidate can
  // never drift by a rounding piaster just because this function ran.
  if (appliedDays === rawValue) return estimatedAmount;
  return Math.round((estimatedAmount / rawValue) * appliedDays * 100) / 100;
}

/**
 * The amount a SUBSET of a candidate's dates charges — the one door every narrowing goes through:
 * a reviewer unticking days, a carried decision, the office-cycle clip and the daily range clip.
 *
 * A CRM row's money was priced by its connector on what its dates WEIGH (a Thursday is half a day,
 * owner rule 2026-08-02), while its `rawValue` stays the plain count of flagged dates. Scaling by the
 * count therefore shares the money out evenly across the dates and loses the weights: base 15,000 in
 * a 31-day October, Mon 19 + Thu 22 = 1.5 days = 725.81; keep only the Thursday and the count says
 * half the money, 362.91, where the Thursday is worth 241.94. So a count-based CRM row (rawValue ===
 * its dates) is scaled by the kept dates' weight over the detected dates' weight.
 *
 * Every other candidate keeps the caller's own `appliedDays` (its dates do not all weigh the same
 * for a reason this helper cannot see — see `daysForTickedDates`). When nothing was narrowed the
 * estimate passes through to the piaster, exactly as `scaleDeductionAmountToDays` does.
 */
export function scaleDeductionAmountToKeptDates(input: {
  appliedDays: number;
  category: string;
  detectedDates: readonly string[];
  estimatedAmount: number | null | undefined;
  keptDates: readonly string[];
  rawValue: number;
}): number | null {
  const detected = [...new Set(input.detectedDates)];
  const detectedSet = new Set(detected);
  const kept = [...new Set(input.keptDates)].filter((date) => detectedSet.has(date));
  const rawValue = Number(input.rawValue);
  if (input.category === "crm" && detected.length > 0 && rawValue === detected.length) {
    const detectedWeight = sumDetectedDeductionDayWeights(detected);
    if (detectedWeight > 0) {
      if (kept.length === detected.length) {
        return scaleDeductionAmountToDays({ estimatedAmount: input.estimatedAmount, rawValue, appliedDays: rawValue });
      }
      return scaleDeductionAmountToDays({
        estimatedAmount: input.estimatedAmount,
        rawValue: detectedWeight,
        appliedDays: sumDetectedDeductionDayWeights(kept),
      });
    }
  }
  return scaleDeductionAmountToDays({
    estimatedAmount: input.estimatedAmount,
    rawValue,
    appliedDays: input.appliedDays,
  });
}

/**
 * The `applied_value` / `applied_amount` a carried decision must write onto its REPLACEMENT
 * candidate when a re-collect supersedes a decided one.
 *
 * `resolveCarriedDecision` re-expresses the reviewer's day selection against the replacement's days,
 * and `appliedDates` then means one of three things:
 *   - `null`  — never narrowed. Keep both figures null so the publish resolvers re-derive the
 *               replacement's FULL value/amount, which is exactly right.
 *   - `[...]` — a NARROWED subset. Pin the figures to that subset, or the resolvers'
 *               `?? rawValue` / `?? estimatedAmount` fallback republishes the full replacement — the
 *               defect this closes (a narrowed approval re-charged at full, a zeroed one re-armed).
 *   - `[]`    — the reviewer cleared every day. appliedValue 0 and appliedAmount 0.00 EXPLICITLY, so
 *               a replacement with no detected days (rawValue 0, where scale would return null and the
 *               publish resolvers fall back to the estimate) cannot re-arm the deliberate zero to full.
 *
 * The amount is scaled from the REPLACEMENT's own estimate (not the old one), the same figure the
 * reviewer now sees on screen — see scaleDeductionAmountToDays.
 */
export function carriedAppliedFigures(input: {
  appliedDates: readonly string[] | null;
  /** The REPLACEMENT's full detected day set — the superset `appliedDates` was narrowed from.
   * Its LENGTH is the only honest denominator for the retained fraction, because `rawValue` is NOT
   * a date count for every category: a fingerprint half-day is `rawValue` 0.5 on a SINGLE date
   * (fingerprint.ts), and a vacation candidate's day-weight can be fractional too. Dividing the
   * retained date COUNT by such a `rawValue` doubled a half-day charge on the carry path — a
   * retained single 0.5-day date scaled `(est / 0.5) × 1 = 2 × est`. */
  replacementDates: readonly string[];
  replacementEstimatedAmount: number | null | undefined;
  replacementRawValue: number;
  /** The candidate's category — a CRM row's kept dates are priced on their weight (Thursday half). */
  category?: string;
}): { appliedValue: number | null; appliedAmount: number | null } {
  if (input.appliedDates == null) return { appliedValue: null, appliedAmount: null };
  const retainedDates = input.appliedDates.length;
  // A cleared decision charges exactly 0.00 regardless of the replacement's own figures — never let a
  // null from scaleDeductionAmountToDays (replacement rawValue 0) fall through to the publish
  // resolvers' estimate fallback and re-arm a deliberately-zeroed decision to full.
  if (retainedDates === 0) return { appliedValue: 0, appliedAmount: 0 };
  // The carried quantity is the retained FRACTION of the replacement's finding — the retained date
  // count over the replacement's total dates — applied to the replacement's own day-VALUE. For a
  // count-based candidate (rawValue === dates.length, every CRM row) this is unchanged. For a
  // fractional one it carries the real weight: a single retained 0.5-day date yields appliedValue
  // 0.5, not 1. Multiply before dividing so the all-retained case lands EXACTLY on rawValue and
  // scaleDeductionAmountToDays's exact passthrough returns the estimate untouched — no rounding
  // piaster, and no doubled half-day.
  const totalDates = input.replacementDates.length;
  const appliedValue =
    totalDates > 0 ? (input.replacementRawValue * retainedDates) / totalDates : input.replacementRawValue;
  const appliedAmount = scaleDeductionAmountToKeptDates({
    appliedDays: appliedValue,
    category: input.category ?? "",
    detectedDates: input.replacementDates,
    estimatedAmount: input.replacementEstimatedAmount,
    keptDates: input.appliedDates,
    rawValue: input.replacementRawValue,
  });
  return { appliedValue, appliedAmount };
}

/**
 * Resolves a day-based deduction candidate's payroll amount: the decided
 * amount if one exists (`appliedAmount`, set on approval), otherwise an
 * ESTIMATE from base salary (base ÷ actual days in month × days) using
 * whichever day count is authoritative (a possibly-edited `appliedValue`,
 * else the original `rawValue`). Keeps "what's shown on the review tab" and
 * "what's actually deducted" in agreement for MANDATORY categories
 * (currently: crm) that count toward payroll even before HR has explicitly
 * decided them. Returns null only when there is no decided amount AND no
 * base salary to estimate from.
 */
export function resolveDayBasedDeductionAmount(input: {
  decision: { appliedValue?: number | null; appliedAmount?: number | null } | null | undefined;
  rawValue: number;
  baseSalary: number | null | undefined;
  month: number;
  year: number;
}): number | null {
  if (input.decision?.appliedAmount != null) return input.decision.appliedAmount;
  const days = input.decision?.appliedValue ?? input.rawValue;
  return calculateDeductionAmountFromBaseSalary({
    baseSalary: input.baseSalary,
    deductionDays: days,
    month: input.month,
    year: input.year,
  });
}

export type CarriedDeductionDecision = {
  decisionStatus: string;
  decisionReason: string;
  /** The reviewer's day selection, re-expressed against the replacement's days. `null` keeps the
   * "never narrowed" meaning — see resolveAppliedDeductionDates for why null and [] differ. */
  appliedDates: string[] | null;
  /** True when the approval could NOT be carried and the replacement must be reviewed again. */
  droppedToPending: boolean;
};

/**
 * What a re-collect should do with a decision the Super Admin already made, when the candidate it
 * was made against is superseded by a recalculated one.
 *
 * THE DEFECT THIS FIXES. Nothing carried a decision forward, so a re-collect silently discarded it:
 * 21 candidates worth 9,306.42 EGP were approved and then retired with no successor, and HR had to
 * re-enter them by hand. But carrying one forward blindly is worse than losing it — it would charge
 * days nobody ever approved.
 *
 * OWNER'S RULE (2026-08-06). Carry the status and the reason. Re-express the day selection against
 * the replacement's days. Re-derive the amount from the replacement rather than reusing the old one.
 * And if the replacement introduces ANY day the approver never saw, drop the whole thing back to
 * Pending so a human looks again — an approval is consent to charge specific days, not a standing
 * licence over whatever that finding later becomes.
 *
 * Pure and total: no clock, no DB, no I/O. The asymmetry is deliberate — a replacement that charges
 * FEWER days keeps the approval (it can only ever charge less than was consented to), while one that
 * charges MORE loses it.
 */
export function resolveCarriedDecision(input: {
  previousStatus: string;
  previousReason: string;
  previousAppliedDates: readonly string[] | null | undefined;
  /** Days the SUPERSEDED candidate detected — the days the approver was actually looking at. */
  previousDates: readonly string[];
  /** Days the REPLACEMENT detects. */
  replacementDates: readonly string[];
}): CarriedDeductionDecision | null {
  const status = String(input.previousStatus ?? "").trim();
  // Pending is the default state, not a decision — there is nothing to carry, and saying so lets
  // the caller skip the write entirely.
  if (!status || status === "Pending") return null;

  const previousDays = new Set(input.previousDates.map((date) => String(date).trim()).filter(Boolean));
  const replacementDays = input.replacementDates.map((date) => String(date).trim()).filter(Boolean);

  const unseenDays = replacementDays.filter((date) => !previousDays.has(date)).sort();
  if (unseenDays.length > 0) {
    return {
      appliedDates: null,
      decisionReason:
        `Reset to Pending automatically: this deduction was re-calculated and now also covers ` +
        `${unseenDays.length} day(s) the previous decision never saw (${unseenDays.slice(0, 5).join(", ")}` +
        `${unseenDays.length > 5 ? ", …" : ""}). The earlier decision was "${status}".`,
      decisionStatus: "Pending",
      droppedToPending: true,
    };
  }

  // Every replacement day was already in front of the approver, so the decision still applies.
  // A null selection stays null: it means "charge whatever this candidate found", and since the
  // replacement's days are a subset of what was approved, that can only ever charge less.
  const previousSelection = input.previousAppliedDates;
  const appliedDates =
    previousSelection == null
      ? null
      : replacementDays
          .filter((date) => previousSelection.map((value) => String(value).trim()).includes(date))
          .sort();

  return {
    appliedDates,
    decisionReason: input.previousReason,
    decisionStatus: status,
    droppedToPending: false,
  };
}
