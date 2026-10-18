/**
 * What an approver's written comment does to a request's `approval_reason`.
 *
 * `approval_reason` is the column the approvals queue reads a claim's comment from, and the
 * system writes into it too: a car journey priced as a chain of drives (or flagged) appends ONE
 * "Journey check:" group to the end of it so the person deciding reads it without opening
 * anything (`withJourneyReason` in chained-journey.ts). The approver's own comment used to REPLACE
 * the whole column, which erased that sentence the moment he typed a word.
 *
 * So the typed comment is the free-text head and the system's "Journey check:" group stays as the
 * tail — the same shape `withJourneyReason` produces, so it can still replace the group (never
 * stack a second one) when a later stop re-prices the journey. The group is also kept in the
 * request's `journey_pricing`, but the queue only shows this column.
 *
 * Pure and import-free, like claim-revision.ts.
 */

/** The marker `withJourneyReason` writes. Pinned equal to it by tests/outstation-stale-approval.test.ts. */
export const JOURNEY_CHECK_MARKER = "Journey check:";

/** The trailing "Journey check:" group of a reason, or "" when it carries none. */
export function journeyCheckSegment(reason: string | null | undefined): string {
  const text = String(reason ?? "");
  const cut = text.indexOf(JOURNEY_CHECK_MARKER);
  return cut >= 0 ? text.slice(cut).trim() : "";
}

function withoutJourneyCheck(text: string): string {
  const cut = text.indexOf(JOURNEY_CHECK_MARKER);
  return (cut >= 0 ? text.slice(0, cut) : text).trim();
}

/**
 * The reason to store when an approver writes `typed` over a claim whose reason is `existing`.
 *
 * - The typed words replace the free text, as before.
 * - The claim's CURRENT "Journey check:" group is kept at the end. When the claim has one, any such
 *   group inside `typed` is dropped first: the Expense Approvals comment box is pre-filled with the
 *   whole stored reason, so what comes back is usually the old group (identical, or stale after a
 *   re-price) and must be replaced by the current one, never appended beside it. A claim with NO
 *   group keeps `typed` exactly as written — those words are his, not the system's.
 * - Clearing the comment leaves just the group (or "" when there is none — the column is NOT NULL).
 */
export function composeDecisionNote(
  existing: string | null | undefined,
  typed: string | null | undefined,
): string {
  const journey = journeyCheckSegment(existing);
  const typedText = String(typed ?? "");
  const head = journey ? withoutJourneyCheck(typedText) : typedText.trim();
  return [head, journey].filter(Boolean).join(" ");
}
