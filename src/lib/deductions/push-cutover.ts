/**
 * The PUSH GATE FOR PAY — RETIRED (owner, 2026-10-07).
 *
 * Owner rule 2026-09-22 made the push "the single gate for pay": from 2026-09, payroll counted a
 * candidate only once its line was pushed, whatever its decision. On 2026-10-07 the owner retired it
 * ("make the Automated Payroll able to read them and every other deduction from the Deductions
 * module") after September 2026 left 17 approved deductions, 11,580.17 EGP, off the sheet. Payroll
 * reads the decision ("Approved for Payroll") again, in every month — July and August always did.
 *
 * The constant is kept as the record of when the gate ran; `monthRequiresPush` answers false for
 * every month so nothing can quietly re-arm it.
 */
export const DEDUCTIONS_PUSH_REQUIRED_FROM_MONTH_KEY = "2026-09";

/** Whether a month is gated on PUSH rather than on the decision alone. Never, since 2026-10-07. */
export function monthRequiresPush(_monthKey: string | null | undefined): boolean {
  return false;
}
