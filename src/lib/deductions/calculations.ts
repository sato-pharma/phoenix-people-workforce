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
export function isEligibleForPublish(candidate: {
  category: DeductionsCategory;
  decision?: { decisionStatus?: string | null } | null;
}): boolean {
  const status = candidate.decision?.decisionStatus ?? "Pending";
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
