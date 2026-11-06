/**
 * The deduction OFFERED for a trip's days with no field activity — never applied on its own.
 *
 * Owner, 2026-11-07 ~01:50, asked how idle days should be deducted: "LET ME DECIDE". So nothing is
 * deducted automatically and no rule is chosen for him: the decision box offers the shares it can
 * compute from the trip's own figures, he picks one per trip (or none), and the amount stays an
 * ordinary editable deduction he can change before Approve.
 *
 *   - "per idle day": the allowance spread evenly over the trip's days, times the idle days
 *     (allowance ÷ trip days × idle days).
 *   - "whole allowance": the trip's full allowance.
 *
 * Only the ALLOWANCE is ever offered. Travel, tickets and meetings are real costs of getting there
 * and back whether or not a visit was logged. When every day is idle the two shares are the same
 * sum, so only one choice is shown. Each share is capped at the claimed total, and rounded to
 * piastres so the Approved figure it leaves is a real amount.
 */

export type IdleDayDeductionInput = {
  allowance: number;
  idleDays: number;
  total: number;
  tripDays: number;
};

export type IdleDayDeductionSuggestion = {
  deduction: number;
  key: "per-idle-day" | "whole-allowance";
  label: string;
  /** Written into the reason box only when it is still empty — never over what he typed. */
  reason: string;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

export function idleDayDeductionSuggestions(input: IdleDayDeductionInput): IdleDayDeductionSuggestion[] {
  const allowance = Number(input.allowance);
  const total = Number(input.total);
  const tripDays = Math.floor(Number(input.tripDays));
  const idleDays = Math.min(Math.floor(Number(input.idleDays)), tripDays);
  if (!(allowance > 0) || !(total > 0) || !(tripDays > 0) || !(idleDays > 0)) return [];

  const days = `${idleDays} of ${tripDays} day${tripDays === 1 ? "" : "s"} with no field activity`;
  const whole = round2(Math.min(allowance, total));
  const perDay = round2(Math.min((allowance / tripDays) * idleDays, total));

  const suggestions: IdleDayDeductionSuggestion[] = [];
  if (perDay < whole) {
    suggestions.push({
      deduction: perDay,
      key: "per-idle-day",
      label: `Allowance for ${idleDays} idle day${idleDays === 1 ? "" : "s"}`,
      reason: `Allowance deducted for the idle days: ${days}.`,
    });
  }
  suggestions.push({
    deduction: whole,
    key: "whole-allowance",
    label: "Whole allowance",
    reason: `Allowance deducted in full: ${days}.`,
  });
  return suggestions;
}
