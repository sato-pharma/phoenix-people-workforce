/**
 * Whether anybody has decided an outstation claim yet — the one answer to "may the employee still
 * add something to it?".
 *
 * A claim is OPEN while it waits for a person (`submitted`, or `needs_review`). The moment HR
 * accepts or rejects it, what HR saw is what payroll will pay: anything the employee added after
 * that would change the figure behind the back of the person who decided it. Owner rule,
 * 2026-10-19: "after HR decision not able to add anything".
 *
 * An ALLOW-list on purpose. The check it replaced refused only statuses that began with
 * "rejected", so every other status passed — `accepted_by_admin`, `accepted_by_system` and the one
 * legacy `approved` — and an extra ticket on an accepted, unpaid claim was re-pushed to payroll at
 * the new, higher total with no one looking at it. A status nobody listed here is treated as
 * decided, so a new status can never reopen a claim by being forgotten.
 *
 * Pure and import-free, like claim-revision.ts.
 */

/** The statuses in which nobody has decided the claim yet. */
export const OUTSTATION_UNDECIDED_STATUSES = ["submitted", "needs_review"] as const;

/** What the employee is told when they try to add to a claim HR has already decided. */
export const OUTSTATION_CLAIM_DECIDED_MESSAGE =
  "HR has already decided this claim, so nothing can be added to it. Ask HR if it needs changing.";

/** True only while the claim still waits for a decision. Anything else — or unreadable — is decided. */
export function isOutstationClaimUndecided(status: unknown): boolean {
  const value = String(status ?? "").trim();
  return (OUTSTATION_UNDECIDED_STATUSES as readonly string[]).includes(value);
}
