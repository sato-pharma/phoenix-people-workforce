import {
  candidateAmount,
  chargedDeductionDays,
  isConfirmedForPayroll,
} from "@/lib/automated-payroll/deductions-source.ts";
import type { DeductionsCandidateWithDecision } from "@/lib/deductions/types.ts";
import { roundCurrency } from "@/lib/payroll/money";

// WHAT A DISPUTED DEDUCTION CHARGES — the one answer every dispute screen measures money from.
//
// 🔴 THE DECISION IS THE CHARGE, NEVER THE PUBLICATION LINE (owner, 2026-10-07 — see
// `buildDeductionBuckets` in automated-payroll/deductions-source.ts: "a candidate counts iff its
// decision is 'Approved for Payroll' … Whether the line was pushed is not read here at all").
//
// Both dispute paths read the LINE's `applied_amount` instead, which is what the employee's portal
// shows and not what the sheet pays, and every money sentence on both hung off it:
//   - a deduction approved but never pushed has no active line, so the dispute read 0.00 as "charged
//     before" and a dispute the employee WON refunded nothing while payroll charged the month in full;
//   - a line an earlier decision withdrew read 0.00 the same way, so the next decision looked like
//     money going back and recommended a second refund on top of the one already live;
//   - the deduction screen's "Reduce" measured its ceiling against the line — or, with no live line,
//     against the DETECTED days, the one figure nobody has decided.
//
// It lives in its own file BECAUSE both paths need it: the deduction dispute (deduction.ts) and the
// weekly-review revision (digest-money.ts), which charges the month-end fingerprint deduction for the
// same day. Two copies of this rule would be two answers to "what does this employee owe".
//
// Payroll's own functions answer it. The row shapes below are structural and snake_case, so each
// caller passes the columns it already selected; nothing here reads the database.

/** The candidate columns the charge rule reads — a subset of `deductions_candidates`. */
export type ChargeCandidateRow = {
  category: string | null;
  dates: unknown;
  estimated_amount: number | string | null;
  raw_value: number | string;
  unit: string;
};

/** The decision columns the charge rule reads — a subset of `deductions_decisions`. */
export type ChargeDecisionRow = {
  applied_amount: number | string | null;
  applied_dates: unknown;
  applied_value: number | string | null;
  decision_status: string | null;
};

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * What payroll charges for this candidate right now: the amount, and the figure in the candidate's
 * own unit behind it. `{ amount: 0, value: 0 }` whenever the decision is anything but "Approved for
 * Payroll" — a status this rule has never heard of pays nothing rather than silently deducting.
 *
 * The narrowed object is cast to payroll's own candidate type because `candidateAmount` and
 * `chargedDeductionDays` read only these fields; inventing the rest of a candidate row would be the
 * second copy this file exists to avoid.
 */
export function payrollCharge(
  candidate: ChargeCandidateRow,
  decision: ChargeDecisionRow | null,
): { amount: number; value: number } {
  const unit = candidate.unit === "amount" ? "amount" : "days";
  const forPayroll = {
    category: candidate.category,
    dates: Array.isArray(candidate.dates) ? (candidate.dates as unknown[]).map(String) : [],
    decision: decision
      ? {
          appliedAmount: decision.applied_amount == null ? null : num(decision.applied_amount),
          appliedDates: Array.isArray(decision.applied_dates) ? (decision.applied_dates as unknown[]).map(String) : null,
          appliedValue: decision.applied_value == null ? null : num(decision.applied_value),
          decisionStatus: decision.decision_status,
        }
      : null,
    estimatedAmount: candidate.estimated_amount == null ? null : num(candidate.estimated_amount),
    rawValue: num(candidate.raw_value),
    unit,
  } as unknown as DeductionsCandidateWithDecision;
  if (!isConfirmedForPayroll(forPayroll)) return { amount: 0, value: 0 };
  const amount = roundCurrency(candidateAmount(forPayroll));
  // For an `amount` candidate the value IS the money (resolveDecisionCharge passes it through
  // untouched); for a `days` one it is the days that money was scaled from.
  return { amount, value: unit === "amount" ? amount : chargedDeductionDays(forPayroll) };
}
