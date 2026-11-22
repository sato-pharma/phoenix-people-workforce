/**
 * Phoenix CRM — "decided before": what a waiting place check says about the customer's EARLIER decision.
 * Pure, no I/O.
 *
 * 🔴 A NEW CAPTURE OF A CUSTOMER ALREADY DECIDED SAYS SO ON ITS ROW (owner, 22 Nov 2026: "I keep approving or
 * rejecting … I come back. I found the same place that I accepted or rejected is as it is"). A rejection
 * sends the rep "Validate again", and he often captures the same door at once: of 878 rejections on
 * production, 190 were captured again, 10 of them within the hour — 0 minutes after the rejection, 3 to 20
 * metres from the refused door, a new photo every time. The new review row read exactly like the one just
 * decided — same doctor, same rep, same territory — so the decider saw "the same place, as it was". The row
 * now says which decision came before and when, and that this is a NEW photo.
 *
 * Only the latest decision made BEFORE this capture counts; a decision made after it is about another
 * photo's place and says nothing about this one.
 */

export type EarlierDecisionSource = {
  customerId: string;
  status: "approved" | "rejected";
  decidedAt: string;
  deciderName: string | null;
  refusalLabel: string | null;
};

export type EarlierDecision = {
  status: "approved" | "rejected";
  decidedAt: string;
  decidedAtText: string;
  /** Null for a viewer who decides nothing (a field a browser receives counts as shown, owner 2026-10-13). */
  deciderName: string | null;
  refusalLabel: string | null;
};

/**
 * The latest decision on `customerId` made before `capturedAt`, or null. An instant that cannot be read is
 * never chosen.
 */
export function earlierDecisionOf(
  customerId: string,
  capturedAt: string,
  decided: ReadonlyArray<EarlierDecisionSource>,
): EarlierDecisionSource | null {
  const captured = Date.parse(capturedAt);
  if (!Number.isFinite(captured)) return null;
  let latest: EarlierDecisionSource | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const decision of decided) {
    if (decision.customerId !== customerId) continue;
    const at = Date.parse(decision.decidedAt);
    if (!Number.isFinite(at) || at >= captured || at <= latestAt) continue;
    latest = decision;
    latestAt = at;
  }
  return latest;
}

/** The one sentence the waiting row prints. A fact, never an instruction. */
export function earlierDecisionText(decision: EarlierDecision): string {
  const verb = decision.status === "rejected" ? "rejected" : "approved";
  const who = decision.deciderName ? ` by ${decision.deciderName}` : "";
  const why = decision.status === "rejected" && decision.refusalLabel ? ` (${decision.refusalLabel})` : "";
  return `An earlier photo of this customer was ${verb}${who} on ${decision.decidedAtText}${why}. This is a new capture.`;
}
