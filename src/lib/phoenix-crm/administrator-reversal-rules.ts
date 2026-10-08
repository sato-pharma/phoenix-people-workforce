/**
 * Phoenix CRM — the Administrator reverses a decision that was already taken (owner, 2026-10-08:
 * "build reversing approved items for the Administrator").
 *
 * 🔴 The Administrator is not an approval step (see `plan-edit-rules.ts`); this is the other half of what
 * he has: besides declining what WAITS, he may take back what was DECIDED, with a comment the rep reads.
 * Three kinds of item, because the weekly and monthly plans are already taken back by his return:
 *   - a REOPENED request to edit a week closes again — only while the rep has not touched the week;
 *   - an APPROVED off-plan visit stops counting;
 *   - an APPROVED list request is undone (grade back, an add leaves the list, a bring-back returns to the
 *     Archive, a drop returns to the list) — refused when anything touched that customer afterwards.
 * Each ends in "refused", so the rep, the district manager and SFE read it as one more decision.
 *
 * Pure rules, no I/O: the screen and the service both import them.
 */

/** How far back a decision can still be taken back. Older ones are history, not something to undo. */
export const ADMINISTRATOR_REVERSAL_DAYS = 14;

/** The comment's ceiling — the database's own (500). */
export const ADMINISTRATOR_REVERSAL_NOTE_MAX = 500;

export const ADMINISTRATOR_REVERSAL_KINDS = ["plan_edit", "visit", "request"] as const;
export type AdministratorReversalKind = (typeof ADMINISTRATOR_REVERSAL_KINDS)[number];

export function isAdministratorReversalKind(value: unknown): value is AdministratorReversalKind {
  return typeof value === "string" && (ADMINISTRATOR_REVERSAL_KINDS as readonly string[]).includes(value);
}

/** One decided item the Administrator can take back, as the Team tab lists it. Names, never codes. */
export type ReversibleItem = {
  kind: AdministratorReversalKind;
  /** The item's own id: a request, a visit or a plan-edit request. */
  id: string;
  /** The item's version, for the kinds whose database function guards on it; null for a list request. */
  version: number | null;
  /** "Reopened week", "Approved off-plan visit", "Approved grade change". */
  label: string;
  /** What it concerns, one line: the customer, or the week. */
  subject: string;
  repName: string;
  territoryName: string;
  /** When it was decided (ISO). */
  decidedAt: string;
};

/** What a reversal of each kind does, in the words the confirmation shows him. */
export const ADMINISTRATOR_REVERSAL_EFFECT: Record<AdministratorReversalKind, string> = {
  plan_edit: "The week closes again, exactly as it was sent. Only possible while the rep has not changed it.",
  visit: "The visit stops counting.",
  request: "The change is undone. Not possible once anything else touched that customer.",
};
