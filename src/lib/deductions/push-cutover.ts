/**
 * The month from which PUSH is the single gate for pay.
 *
 * Owner rule 2026-09-22: "push is the single gate for pay too". From here on nothing is deducted
 * until the Super Admin pushes that specific line, so payroll counts a candidate iff it has an
 * ACTIVE pushed line — not merely a decision of "Approved for Payroll".
 *
 * Deliberately LATER than the module's own `DEDUCTIONS_CUTOVER_MONTH_KEY` (2026-07, when the module
 * became the system of record). July and August 2026 were already published and their batches
 * approved and closed under the old "approved reaches payroll" rule — a published-and-announced
 * month is never re-gated (owner). September 2026 was provably clean when this shipped: no salary
 * batch, no candidates and no publication rows, so no pay figure moved the instant it landed.
 * Compared lexically — `YYYY-MM` is zero-padded, so string order is chronological.
 *
 * IT LIVES IN ITS OWN FILE SO THE BROWSER CAN HAVE IT. The Deductions workspace has to tell an
 * approved-but-unpushed row apart from a released one, and that is a question about this month and
 * this constant; it used to sit in `automated-payroll/deductions-source.ts`, which reaches the
 * Supabase admin client and cannot be imported from a client component. Duplicating the string
 * instead would put two answers in the system to "when did the gate change", which is precisely the
 * class of bug the push gate exists inside.
 */
export const DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY = "2026-09";

/** Whether a month is gated on PUSH rather than on the decision alone. */
export function monthRequiresPush(monthKey: string | null | undefined): boolean {
  const key = (monthKey ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(key)) return false;
  return key >= DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY;
}
