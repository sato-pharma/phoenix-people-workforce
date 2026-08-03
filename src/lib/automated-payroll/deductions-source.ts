import {
  resolveAppliedDeductionDates,
  scaleDeductionAmountToDays,
} from "@/lib/deductions/calculations";
import { listCandidatesForMonth } from "@/lib/deductions/service";
import type { DeductionsCandidateWithDecision, DeductionsCategory } from "@/lib/deductions/types";
import { logError } from "@/lib/observability/log";
import { roundCurrency } from "@/lib/payroll/money";

import type { PayrollPeriod } from "./types.ts";

/**
 * The bridge from the Deductions module to the Automated Payroll sheet.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-03). Two deduction systems shipped
 * side by side with table names one letter apart — `deductions_candidates` /
 * `deductions_decisions` (the Deductions workspace HR actually works in) and
 * `deduction_candidates` / `deduction_decisions` (the older governance flow).
 * Payroll read the second; HR confirmed in the first. They had never been
 * connected, and the Deductions page said so in its own nav description:
 * "Phase 1 preview — feeds nothing live yet."
 *
 * Measured on production for July 2026 before this shipped: 32 employees and
 * 34,443.50 EGP approved in the workspace, against 8,480.60 EGP across 9
 * employees sitting in the payroll run. Exactly one employee agreed. This module
 * is what makes the number HR confirms the number payroll pays.
 *
 * WHAT COUNTS — owner rule, 2026-08-03: "only the deductions I confirmed to
 * payroll will appear in Automated Payroll." A candidate reaches the sheet if
 * and only if its decision is "Approved for Payroll". Pending, Needs Follow-up,
 * Disputed and Do Not Take Action all pay nothing.
 *
 * This DELIBERATELY DIVERGES from the module's own `isEligibleForPublish`, which
 * treats `crm` as mandatory ("whoever has N days must be deducted") and counts
 * it while still Pending. That rule still governs the module's own Overview and
 * publish snapshot; it does not govern payroll. The owner's reason is the
 * stronger one for money leaving the company: it was surfaced to him that a
 * single undecided July CRM row would charge one employee 8,709.68 EGP with no
 * decision recorded against it, and he ruled that nothing should be deducted
 * that he has not explicitly confirmed.
 *
 * The practical consequence is a payroll figure that can be LOWER than the
 * module's Overview total for the same month. That is intended, and the gap is
 * always exactly the not-yet-confirmed rows — approving them closes it.
 *
 * HOW MUCH is NOT re-implemented here, because a second copy of that rule is a
 * second answer to "what does this employee owe": the decided `appliedAmount`
 * when the reviewer set one, else the candidate's own estimate scaled to the
 * days actually charged (`scaleDeductionAmountToDays`). Scaling the candidate's
 * own figure rather than recomputing from base salary is the module's deliberate
 * choice, so a row cannot jump because payroll changed that salary last week.
 *
 * This module reads only. Nothing here decides, approves, or writes back — the
 * wizard still freezes whatever HR confirms into its own draft rows.
 */

/** The one decision state that lets money reach the payroll sheet (owner rule 2026-08-03). */
export const PAYROLL_APPROVED_STATUS = "Approved for Payroll";

/**
 * Whether a candidate is confirmed for payroll. Deliberately explicit rather
 * than "not rejected": a status this function has never heard of must fail
 * CLOSED (pay nothing) rather than silently deduct.
 */
export function isConfirmedForPayroll(candidate: {
  decision?: { decisionStatus?: string | null } | null;
}): boolean {
  return (candidate.decision?.decisionStatus ?? "Pending") === PAYROLL_APPROVED_STATUS;
}

/** Payroll-facing buckets. Mirrors the module's own category → salary-column mapping. */
export type DeductionBuckets = {
  /** → Part 1 fingerprint step (`fingerprintValue`). */
  fingerprint: number;
  /** → the CRM step for this employee's part (`crm` / `p1odCrmValue`). */
  crm: number;
  /** unpaid_vacation + insufficient_balance_vacation → the vacation step. */
  unpaidVacation: number;
  /** → Part 1 Other Deductions, Loan column. */
  loan: number;
  /** other + the retired no_records_activity → Part 1 Other Deductions, Other column. */
  other: number;
};

/** One eligible candidate behind a bucket total — feeds the step's expandable breakdown. */
export type DeductionLine = {
  category: DeductionsCategory;
  /** The days actually charged (already narrowed to the reviewer's selection). */
  dates: string[];
  days: number;
  amount: number;
  reason: string;
  status: string;
};

export type EmployeeDeductions = {
  buckets: DeductionBuckets;
  lines: DeductionLine[];
};

export function emptyBuckets(): DeductionBuckets {
  return { fingerprint: 0, crm: 0, unpaidVacation: 0, loan: 0, other: 0 };
}

/** Which payroll bucket a category lands in. Mirrors DEDUCTIONS_CATEGORY_CONFIG's salaryRecordsColumn. */
function bucketFor(category: DeductionsCategory): keyof DeductionBuckets {
  switch (category) {
    case "fingerprint":
      return "fingerprint";
    case "crm":
      return "crm";
    case "unpaid_vacation":
    case "insufficient_balance_vacation":
      return "unpaidVacation";
    case "loan":
      return "loan";
    // no_records_activity is retired but historical rows remain valid payroll
    // history, and its salary column was always other_deductions.
    case "no_records_activity":
    case "other":
      return "other";
  }
}

/**
 * One candidate's payable amount. Returns 0 rather than null for an
 * unresolvable row: the candidate passed the module's eligibility gate, so it
 * belongs on the sheet, and a null here would silently drop it instead.
 */
export function candidateAmount(candidate: DeductionsCandidateWithDecision): number {
  const decided = candidate.decision?.appliedAmount;
  if (decided != null && Number.isFinite(decided)) return roundCurrency(decided);

  if (candidate.unit !== "days") return roundCurrency(candidate.estimatedAmount ?? 0);

  const charged = resolveAppliedDeductionDates(candidate).length;
  const scaled = scaleDeductionAmountToDays({
    estimatedAmount: candidate.estimatedAmount,
    rawValue: candidate.rawValue,
    appliedDays: charged,
  });
  return roundCurrency(scaled ?? candidate.estimatedAmount ?? 0);
}

/**
 * Folds the month's eligible candidates into per-employee buckets. Pure and
 * exported so the mapping and the eligibility gate are unit-tested without a
 * database — this decides real money, and a rule that only exists inside a
 * Supabase round-trip cannot be pinned by a test.
 */
export function buildDeductionBuckets(
  candidates: DeductionsCandidateWithDecision[],
): Map<string, EmployeeDeductions> {
  const byCompact = new Map<string, EmployeeDeductions>();
  for (const candidate of candidates) {
    if (candidate.supersededAt) continue;
    if (!isConfirmedForPayroll(candidate)) continue;
    const compact = candidate.employeeHrIdCompact;
    if (!compact) continue;

    const amount = candidateAmount(candidate);
    const entry = byCompact.get(compact) ?? { buckets: emptyBuckets(), lines: [] };
    const bucket = bucketFor(candidate.category);
    entry.buckets[bucket] = roundCurrency(entry.buckets[bucket] + amount);

    const dates = resolveAppliedDeductionDates(candidate);
    entry.lines.push({
      category: candidate.category,
      dates,
      days: candidate.unit === "days" ? dates.length : 0,
      amount,
      reason: candidate.reason ?? "",
      status: candidate.decision?.decisionStatus ?? "Pending",
    });
    byCompact.set(compact, entry);
  }
  return byCompact;
}

/**
 * Every employee's confirmed deductions for a payroll period, keyed by compact
 * HR id.
 *
 * Defensive by design: a failure here returns an EMPTY map, which recommends
 * zero deductions rather than blocking the whole wizard. That is the safe
 * direction — a zero is visible to HR on the step and can be corrected, whereas
 * an exception takes down a payroll screen HR cannot work around. It is logged
 * loudly so the cause is findable rather than silent.
 */
export async function loadConfirmedDeductions(
  period: PayrollPeriod,
): Promise<Map<string, EmployeeDeductions>> {
  const monthKey = `${period.year}-${String(period.month).padStart(2, "0")}`;
  try {
    const candidates = await listCandidatesForMonth({ monthKey });
    return buildDeductionBuckets(candidates);
  } catch (error) {
    logError("Automated payroll: confirmed-deductions load failed", {
      labels: {
        event: "automated_payroll_confirmed_deductions_load_failed",
        month: period.month,
        year: period.year,
      },
      error,
    });
    return new Map();
  }
}

/** This employee's buckets, or all-zero when the month produced nothing for them. */
export function bucketsFor(
  deductions: Map<string, EmployeeDeductions>,
  compact: string,
): DeductionBuckets {
  return deductions.get(compact)?.buckets ?? emptyBuckets();
}

/** This employee's eligible lines for one bucket, for the step's breakdown panel. */
export function linesFor(
  deductions: Map<string, EmployeeDeductions>,
  compact: string,
  bucket: keyof DeductionBuckets,
): DeductionLine[] {
  return (deductions.get(compact)?.lines ?? []).filter((line) => bucketFor(line.category) === bucket);
}
