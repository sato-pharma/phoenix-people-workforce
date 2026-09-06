import { logsOwnCrmVisitsTitle } from "@/lib/field-workforce-compliance/eligibility";

/**
 * Who this board is about: Medical Reps, and nobody else, on BOTH rules.
 *
 * One exported predicate rather than an inline `.filter` in the service, because the scoping is the
 * thing that keeps being got wrong and a behavioural test can only pin what it can call.
 *
 * The silence rule was rep-only from the start — a rep owns a contact list and enters their own
 * visits, while a manager appears in the CRM only when one of their reps tags them. The LEAVE rule
 * was not: it began company-wide on the owner's first instruction, "every single employee who take
 * five consecutive day vacations". Looking at the live board on 2026-09-07 he corrected it —
 * "medical reps only i said" — because three of its seven rows were the Finance & Admin Manager,
 * the National Sales Manager and the Marketing Manager, each on five days of ordinary approved
 * leave. Head-office leave is a holiday; it is already on the vacation report, and it is not a
 * retention signal.
 *
 * Delegates to `logsOwnCrmVisitsTitle` rather than restating the titles, so this board and the
 * payroll deduction connector can never disagree about who owns a CRM contact list.
 */
export function isRetentionRiskSubjectTitle(...titles: Array<string | null | undefined>): boolean {
  return logsOwnCrmVisitsTitle(...titles);
}
