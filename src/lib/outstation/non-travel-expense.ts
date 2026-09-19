/**
 * Meeting and Other expenses are NOT trips.
 *
 * Owner request, 2026-09-19: on the portal Submit Expense screen a Meeting or Other expense must
 * not calculate a distance or any travel — it is priced on the amounts the employee types, and it
 * carries an uploaded invoice or picture (JPG, PNG or PDF) as its evidence. Before this, the screen
 * made every type go through the same trip flow: tap "To" to capture GPS, a Google route, a fuel or
 * ticket cost, a per-diem allowance, a distance-eligibility floor and a live arrival photo — and
 * offered an upload only for train and bus.
 *
 * The admin manual-expense path already priced a Meeting this way (owner rule, 2026-09-04, in
 * `createManagerExpenseAsAdmin`); this module is the employee half, for BOTH types.
 *
 * A Traveling expense is untouched, including one that also carries a meeting or parking amount —
 * the two amount boxes stay on every type (see the note on them in mobile-outstation-wizard.tsx).
 *
 * Pure on purpose, like allowance-day-guard.ts: it decides what money is claimed, so it must be
 * assertable without a database.
 */

import type { OutstationExpenseType } from "@/lib/outstation/types";

export type NonTravelExpenseType = Exclude<OutstationExpenseType, "traveling">;

/**
 * What `captured_location_source` records for these rows. Neither the wizard nor the server took a
 * position for them, so the column (NOT NULL, with a required latitude/longitude beside it) holds
 * the employee's registered residence and this marker says so — the same device
 * `submitMedicalRepSimpleExpenseRequest` uses with `medical_rep_manual`. It is never `browser_gps`,
 * which would claim a fix that was never taken.
 */
export const NON_TRAVEL_LOCATION_SOURCE = "no_travel_expense" as const;

export function isNonTravelExpenseType(value: unknown): value is NonTravelExpenseType {
  return value === "meeting" || value === "other";
}

/** What the request list and payroll show as the destination — there is none. */
export function nonTravelDestinationLabel(expenseType: NonTravelExpenseType) {
  return expenseType === "meeting" ? "Meeting expense (no travel)" : "Other expense (no travel)";
}

/** The trip-type label the reports carry in place of "Return same day" / "Overnight". */
export function nonTravelTripLabel(expenseType: NonTravelExpenseType) {
  return expenseType === "meeting" ? "Meeting" : "Other";
}

export const NON_TRAVEL_ELIGIBILITY_REASON =
  "Meeting or Other expense — priced on the amounts alone. No distance, travel cost or allowance is calculated.";

export const NON_TRAVEL_APPROVAL_REASON =
  "Meeting or Other expense with no travel to price. Amount and evidence are ready for review.";

/**
 * The reason a Meeting/Other claim with no invoice is HELD rather than refused — the owner's
 * "the system flags, it never rejects" rule (2026-08-09). Whatever the employee typed still
 * submits; a person reads it before it moves to payroll.
 */
export const NON_TRAVEL_NO_INVOICE_HOLD_REASON =
  "This Meeting or Other expense has no invoice or picture attached, so it is held for Super Admin review before it moves to payroll.";

/** The refusal when neither amount was entered. Worded so the submit route answers it with a 400. */
export const NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE =
  "Enter the Meeting amount or the Other amount — one is required for a Meeting or Other expense.";

function cleanAmount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 100) / 100 : 0;
}

/** null when the claim carries an amount; the refusal to show otherwise. */
export function nonTravelAmountRefusal(input: {
  meetingAmount: unknown;
  otherAmount: unknown;
}): string | null {
  return cleanAmount(input.meetingAmount) + cleanAmount(input.otherAmount) > 0
    ? null
    : NON_TRAVEL_AMOUNT_REQUIRED_MESSAGE;
}

/**
 * The figures a Meeting/Other claim is priced at: the two typed amounts and nothing else.
 * Travel cost, fuel, ticket and allowance are ZERO by rule, whatever the client posted — a stale
 * kilometre reading or ticket amount left over from switching type must never reach the row.
 */
export function priceNonTravelExpense(input: { meetingAmount: unknown; otherAmount: unknown }) {
  const meetingAmount = cleanAmount(input.meetingAmount);
  const otherAmount = cleanAmount(input.otherAmount);

  return {
    allowanceAmount: 0,
    fuelAmount: 0,
    meetingAmount,
    otherAmount,
    ticketAmount: 0,
    totalAmount: Math.round((meetingAmount + otherAmount) * 100) / 100,
    travelCost: 0,
  };
}
