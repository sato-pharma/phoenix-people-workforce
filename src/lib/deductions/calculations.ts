// Unified Deductions module: pure calculation helpers. No DB I/O.
// Ported from deductions-governance/calculations.ts.

import { calendarDaysInMonth } from "@/lib/payroll/copilot/proration.ts";
import type { DeductionsCategory, DeductionsCategoryConfig, DeductionsSalaryRecordsColumn } from "./types.ts";

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
  no_records_activity: {
    category: "no_records_activity",
    label: "No Records Activity",
    detectionEngine: "no_activity_engine",
    requiresApproval: true,
    salaryRecordsColumn: "other_deductions",
    sortOrder: 3,
  },
  unpaid_vacation: {
    category: "unpaid_vacation",
    label: "Unpaid Vacation",
    detectionEngine: "vacation_balance",
    requiresApproval: true,
    salaryRecordsColumn: "unpaid_vacations",
    sortOrder: 4,
  },
  insufficient_balance_vacation: {
    category: "insufficient_balance_vacation",
    label: "Insufficient Balance Vacation",
    detectionEngine: "vacation_balance",
    requiresApproval: true,
    salaryRecordsColumn: "unpaid_vacations",
    sortOrder: 5,
  },
  loan: {
    category: "loan",
    label: "Loan",
    detectionEngine: "manual_hr",
    requiresApproval: true,
    salaryRecordsColumn: "loans",
    sortOrder: 6,
  },
  other: {
    category: "other",
    label: "Other",
    detectionEngine: "manual_hr",
    requiresApproval: true,
    salaryRecordsColumn: "other_deductions",
    sortOrder: 7,
  },
};

export function deductionsCategoryLabel(category: DeductionsCategory): string {
  return DEDUCTIONS_CATEGORY_CONFIG[category].label;
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
