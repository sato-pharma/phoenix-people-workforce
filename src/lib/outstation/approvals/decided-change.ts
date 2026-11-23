/**
 * What can still be pressed on a claim that was ALREADY decided — the one answer the History row,
 * the opened trip and the server all read.
 *
 * Owner, 23 Nov 2026 (about 21:05 Cairo): "make me able to reject even if approved in history. Make
 * me easily able to approve or reject." That lifts the desk's first rule of the same day, "decided
 * trips read-only". It lifts it for exactly two presses, each of which the outstation workflow
 * already makes and this file re-implements nothing of:
 *
 *   approved, and no payroll has taken it   →  Reject. The workflow's own `reject_before_payroll`
 *   (held, or waiting for the next payroll)     pulls the claim's payroll row out, re-reads a
 *                                               confirmed Expenses step, audits it and tells the
 *                                               employee.
 *   rejected                                →  Approve, IN FULL. The workflow's own override of a
 *                                               rejection, through the same one database step and
 *                                               the same payroll gate as any approval.
 *
 * What stays closed, and why:
 *
 *   - 🔴 An APPROVED claim is never approved again and never reduced here. That is the press the risk
 *     review of 23 Nov traced: History → Open → "Pay in full" on a claim approved at EGP 900 of
 *     1,200 wrote the typed amount to nothing, and payroll would have paid 1,200. To pay less on a
 *     claim already approved: reject it, then approve it.
 *   - A claim a payroll took is locked. The money has moved.
 *   - 🔴 A claim whose payout month's payroll has ALREADY RUN (`approved_missed`) is not changed
 *     here either. It is not marked paid, but unstamped is not unpaid: it may have been paid through
 *     a held salary released later, or a figure typed in that payroll (standing.ts). Rejecting it
 *     would pull a row out from under a payroll that has run. It names the screen to check instead.
 *   - A rejected claim is not reduced here: its idle days and its payroll hold are read for a
 *     WAITING claim only, and a reduced amount needs both.
 *
 *
 * 🔴 The standing above is read from the PAID STAMPS, and a payroll can hold a trip before it
 * stamps it. So both presses are also checked against the payout month's own payroll run, read by
 * decide.ts just before anything is written (risk review of this change, 23 Nov 2026):
 *
 *   - the run's second part is confirmed: its expense figures are frozen. Rejecting deleted the
 *     payroll row, the re-sync was skipped, and publishing still paid the trip — while the employee
 *     was told "rejected" and the desk said "saved". Refused, and the screen to reopen it named;
 *   - the run is published, or the month is on or before August 2026 (paid before the stamps were
 *     kept): approving a rejected claim into it would read "in payroll" while no payroll ever pays
 *     it, and rejecting would pull a row out from under a payroll that has run. Refused;
 *   - the run could not be read, or the claim names no payout month: refused. Money is not moved on
 *     a guess.
 *
 * Pure: the standing module and nothing that reads.
 */

import { paidBeforeStampsWereKept, type TripStanding } from "@/lib/outstation/approvals/standing";

export type DecidedChange = "approve" | "reject";

export const DECIDED_CHANGE_REFUSAL = {
  approvedOnlyReject: "This claim is already approved. It can be rejected here, not approved again or reduced.",
  inPayroll: "A payroll has already taken this trip, so it cannot be changed here.",
  noPayoutMonth: "This trip names no payout month, so which payroll would pay it cannot be told. Nothing changed.",
  part2Confirmed:
    "The payroll that pays this trip already has its second part confirmed, so its expenses are frozen and this cannot be changed here. Reopen the second part in Automated Payroll first. Nothing changed.",
  payrollRan:
    "The payroll of this trip's payout month has already run, so it cannot be changed here. Check the payroll Expenses step before anything is paid or taken back.",
  rejectedOnlyApprove: "This claim is rejected. It can be approved in full here, not reduced or rejected again.",
  runUnread: "The payroll that pays this trip could not be read just now, so nothing changed. Try again in a moment.",
} as const;

/**
 * The reason kept on a claim approved after a rejection, when he typed none. Without it the old
 * rejection reason would stay on an approved claim and read as the reason it was approved.
 */
export const APPROVED_AFTER_REJECTION_NOTE = "Approved after an earlier rejection.";

/**
 * The one press still open on a decided claim, or the sentence saying why there is none. A waiting
 * claim answers `{ offer: null, why: null }`: it is decided by the desk's own four presses, not here.
 */
export function decidedChange(claim: { locked: boolean; standing: TripStanding }): { offer: DecidedChange | null; why: string | null } {
  if (claim.standing === "waiting") return { offer: null, why: null };
  if (claim.locked || claim.standing === "in_payroll") return { offer: null, why: DECIDED_CHANGE_REFUSAL.inPayroll };
  if (claim.standing === "approved_missed") return { offer: null, why: DECIDED_CHANGE_REFUSAL.payrollRan };
  if (claim.standing === "rejected") return { offer: "approve", why: null };
  return { offer: "reject", why: null };
}

/** The payout month's payroll run, as decide.ts read it; null when it could not be read. */
export type PayoutRunReading = { part2Confirmed: boolean; published: boolean } | null;

/**
 * The refusal of a change to a decided claim that its payout month's payroll run makes, or null
 * when the run leaves it open. Asked for both presses, after `decidedChange` offered one.
 */
export function decidedChangeRunRefusal(input: { payoutMonth: number | null; payoutYear: number | null; run: PayoutRunReading }): string | null {
  const month = Number(input.payoutMonth);
  const year = Number(input.payoutYear);
  if (input.payoutMonth === null || input.payoutYear === null || !Number.isInteger(month) || !Number.isInteger(year) || month < 1 || month > 12) {
    return DECIDED_CHANGE_REFUSAL.noPayoutMonth;
  }
  if (paidBeforeStampsWereKept(month, year)) return DECIDED_CHANGE_REFUSAL.payrollRan;
  if (!input.run) return DECIDED_CHANGE_REFUSAL.runUnread;
  if (input.run.published) return DECIDED_CHANGE_REFUSAL.payrollRan;
  if (input.run.part2Confirmed) return DECIDED_CHANGE_REFUSAL.part2Confirmed;
  return null;
}
