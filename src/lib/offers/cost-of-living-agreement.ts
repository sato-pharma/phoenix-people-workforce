import { resolveTitleAllowances } from "@/lib/payroll/salary-autofill";

/**
 * The offer letter's cost of living and payroll's, held against each other.
 *
 * ── The two numbers, and why they are two ──
 * An offer carries ONE cost-of-living figure per job title, typed on the Job titles tab and stored
 * in `offer_job_titles.cost_of_living`. The employee record carries TWO — `extra_cost_of_living` and
 * `fuel_allowance` — resolved in code by `resolveTitleAllowances`. They describe the same money at
 * different grain, and the letter's figure is the sum of payroll's pair.
 *
 * Measured on production 2026-09-29, every active title agrees:
 *
 *   Medical Representative   offer 2,500 = 2,000 + 500
 *   District Sales Manager   offer 3,500 = 3,000 + 500
 *   National Sales Manager   offer 5,500 = 5,000 + 500
 *
 * ── Why that agreement needs guarding ──
 * NOTHING enforced it. The offer side is DATA, editable from the Job titles tab; the payroll side is
 * CODE. Change either alone and the letter and the employee record quietly describe different money
 * — on a document somebody signs, against which they are then paid. There is no error to see,
 * because each side is internally consistent; they simply stop meaning the same thing.
 *
 * It is not hypothetical arithmetic: the whole reason `buildOfferHireDraft` carries only the NET is
 * that the form's chain re-derives the split. That chain uses PAYROLL's pair. So the day the offer's
 * figure drifts, the letter's compensation table and the hire it produces disagree by exactly the
 * drift, silently.
 *
 * ── This FLAGS, it never refuses ──
 * Same shape as every other judgement call in this system: a cost of living the owner deliberately
 * changes is legitimate, and a guard that blocked it would be wrong. What must not happen is the two
 * drifting APART without anybody being told. So this returns a sentence, and the screen shows it.
 *
 * ── It derives nothing ──
 * `resolveTitleAllowances` is the only authority on payroll's pair and is called, never re-stated.
 * A second copy of those numbers here would be the very drift this file exists to catch.
 */

/** Payroll's cost of living for a title: the allowance plus fuel, as one figure. */
export function payrollCostOfLivingForTitle(jobTitle: string | null | undefined): number {
  const allowances = resolveTitleAllowances(jobTitle, null);
  return allowances.extraCostOfLiving + allowances.fuelAllowance;
}

/**
 * Why this title's offer cost of living disagrees with payroll's, or null when they agree.
 *
 * Null for a blank or unreadable figure too: an empty box is somebody mid-edit, not a drift, and
 * shouting at a half-typed number is how a warning gets ignored.
 */
export function offerCostOfLivingDrift(input: {
  costOfLiving: number | string | null | undefined;
  jobTitle: string | null | undefined;
}): string | null {
  const offerSide = Number(input.costOfLiving);
  if (!Number.isFinite(offerSide) || offerSide <= 0) return null;

  const title = String(input.jobTitle ?? "").trim();
  if (!title) return null;

  const payrollSide = payrollCostOfLivingForTitle(title);
  // A title payroll has no figure for resolves to its office default, which says nothing about
  // this title in particular — reporting that as a disagreement would cry wolf on every new title.
  if (payrollSide <= 0) return null;
  if (offerSide === payrollSide) return null;

  const allowances = resolveTitleAllowances(title, null);
  return (
    `The letter would say ${offerSide.toLocaleString("en-US")} for cost of living, but a hire on this title ` +
    `is paid ${payrollSide.toLocaleString("en-US")} ` +
    `(${allowances.extraCostOfLiving.toLocaleString("en-US")} cost of living + ${allowances.fuelAllowance.toLocaleString("en-US")} fuel). ` +
    `The offer and the employee record would describe different money.`
  );
}
