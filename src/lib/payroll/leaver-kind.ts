/**
 * Is this leaver a RESIGNATION, or was the company the one that ended it?
 *
 * WHY IT MATTERS. Resignation Rule 1's generosity — a last working day after the 25th is paid a
 * full month of Base plus both allowances — belongs to genuine resignations only (owner ruling,
 * 2026-08-14). A `terminated` (dismissed) or `inactive` (deactivated) leaver keeps NEITHER
 * allowance and has Base prorated to the days actually worked, with no waiver.
 *
 * WHY IT LIVES HERE. The Ready sheet has always applied that gate, deriving it from
 * `employees.employment_status`. The Automated Payroll engine never did — it identifies a leaver
 * from the `employee_resignations` workflow, and `proration.ts` carried a comment asserting that
 * this meant it "never sees" a dismissal. That is not true, and production shows why: Kareem Gamal
 * Ahmed Mohamed is `terminated` on the employee master and carries an `employee_resignations` row
 * at `exit_status = completed`. The exit workflow is how EVERY departure is recorded, however it
 * came about; it is a process, not a reason.
 *
 * So the workflow cannot answer the question and the employment status can. One definition, used by
 * every engine, rather than a local constant in whichever route happened to need it first.
 *
 * ARMED, NOT YET FIRED. Both terminations on record left before the 25th (5 May and 7 July 2026),
 * where the waiver is not reached. The gap has cost nothing so far — which is precisely how a
 * comment claiming it was impossible survived unchallenged.
 */

/** The employment status that means the employee chose to leave. */
const RESIGNED_STATUS = "resigned";

/**
 * True only for a genuine resignation.
 *
 * Anything else — `terminated`, `inactive`, a blank, an unrecognised value — answers false, so an
 * unreadable status withholds the generosity rather than granting it. That direction is deliberate:
 * the failure that costs money is paying a dismissal a full month, and a wrongly-withheld allowance
 * is visible to the person it affects on the day they are paid, while a wrongly-granted one is
 * visible to nobody.
 */
export function isResignationEmploymentStatus(status: string | null | undefined): boolean {
  return String(status ?? "").trim().toLowerCase() === RESIGNED_STATUS;
}
