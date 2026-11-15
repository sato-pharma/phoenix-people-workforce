/**
 * THE WORDS A CRM NO-ACTIVITY DEDUCTION CARRIES — what it read, in the current systems' names.
 *
 * Owner, 2026-11-15: the Daily Deductions page still showed every CRM line as "Field Workforce
 * Compliance no-activity candidate" — the name of the old iReports360 compliance audit — nine days
 * after iReports360 was retired (6 November 2026). The connector itself already reads today's
 * sources (`connectors/crm.ts` → `field-workforce-compliance/ireports360-source.ts` →
 * `deductions/proven-worked-days.ts`): Phoenix CRM visits and day activities, approved HR leave,
 * outstation trips, a manager's own single visits and accepted Private Calendar review requests,
 * with the iReports360 archive answering only for days before the retirement. The reason now says
 * that, and {@link currentDeductionReason} renames the old text on rows already stored, so a line
 * released before this change reads the same as one released after it.
 *
 * Pure: the readers of stored rows (daily lines, month candidates, payslip lines, the Dispute
 * Center) all pass `reason` through it.
 */

export const CRM_NO_ACTIVITY_REASON =
  "No field work recorded that day in any source — no Phoenix CRM visit or day activity (training, meeting, travel), " +
  "no approved leave, no outstation trip and no accepted review request. Days before 6 Nov 2026 are read from the iReports360 archive.";

/** The reason the CRM connector wrote until 2026-11-15. Stored rows still carry it. */
export const RETIRED_CRM_NO_ACTIVITY_REASON = "Field Workforce Compliance no-activity candidate";

/** A stored deduction reason in today's words — the retired CRM audit name becomes the current one; anything else is returned as stored. */
export function currentDeductionReason(reason: string): string;
export function currentDeductionReason(reason: string | null): string | null;
export function currentDeductionReason(reason: string | null): string | null {
  if (reason == null) return reason;
  return reason.trim() === RETIRED_CRM_NO_ACTIVITY_REASON ? CRM_NO_ACTIVITY_REASON : reason;
}
