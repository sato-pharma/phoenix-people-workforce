/**
 * The shared "already validated" stamp, computed once and rendered the same way on both approver
 * windows — the direct-order pharmacy approver and the marketing-request customer approver.
 *
 * Owner ask (2026-09-22): when an approver opens an order/request whose venue is already validated,
 * tell them so, with WHO validated it and WHEN, and give them a jump to the evidence.
 *
 * The two systems validate two different ways, so the badge carries an honest `isHuman`:
 *  - a person adjudicated it  → isHuman true,  byName is that person's resolved name;
 *  - the SYSTEM evidence-gate passed it, NO HUMAN LOOKED → isHuman false, byName stays null and the
 *    stamp reads "by the system", never a fabricated reviewer. `atIso` is then the evidence-capture
 *    moment — the only honest "when" the system case has.
 */
export type ValidationBadge = {
  /** True when a person adjudicated the venue; false when only the system evidence-gate passed it. */
  isHuman: boolean;
  /** The human validator's resolved name — null in the system case, or when the id could not resolve. */
  byName: string | null;
  /** When it was validated (a person's decision), or when the evidence was captured (the system case). */
  atIso: string | null;
  /** A short note on how it was validated, e.g. "distributor invoice", "field capture", "desk". */
  method: string | null;
};

export type ValidationBadgeInput = {
  /** Is the venue in a validated state at all? When false, there is no badge to show. */
  validated: boolean;
  /** Did a human adjudicate it (vs. the system evidence-gate)? */
  isHuman: boolean;
  /** The human validator's resolved name; ignored in the system case. */
  byName: string | null;
  /** The validation moment, or the evidence-capture moment for the system case. */
  atIso: string | null;
  /** Optional short "how" label. */
  method?: string | null;
};

/**
 * Pure. Turns a domain's raw validation facts into the badge the two windows render, or null when
 * the venue is not validated (a fresh, pending or rejected venue shows no stamp).
 *
 * The one rule it enforces for both callers: a name is only ever shown when a HUMAN looked. In the
 * system case the name is dropped even if a row happens to carry an id, because that id is the
 * capturing owner, not a reviewer — and "validated by <the rep who captured it>" would read as an
 * independent check that never happened.
 */
export function buildValidationBadge(input: ValidationBadgeInput): ValidationBadge | null {
  if (!input.validated) return null;
  return {
    isHuman: input.isHuman,
    byName: input.isHuman ? input.byName ?? null : null,
    atIso: input.atIso ?? null,
    method: input.method ?? null,
  };
}
