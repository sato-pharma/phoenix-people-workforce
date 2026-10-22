/**
 * A train or bus claim that reached Phoenix WITHOUT its ticket, and the employee attaching it
 * afterwards.
 *
 * Why it exists (owner, 2026-10-22: "fix … the offline ticket gap in outstation"). A claim saved
 * while the phone reported no signal is replayed later from the phone's own storage, and that
 * replay cannot carry files — so it lands with no ticket, held as "Ticket-based trips require
 * attachment evidence". Until now the employee had no way to supply it: his only ticket tool was
 * "Add tickets", which adds MONEY (a new leg at a new cost), never proof for the ticket he already
 * claimed. Osama Mohamed El-said's 20 Oct train to Assiut (EGP 90 ticket) sat exactly there.
 *
 * Attaching the missing ticket is EVIDENCE ONLY: no amount moves, so the claim's `updated_at` (its
 * approval revision, claim-revision.ts) is left alone, exactly as a workload grab leaves it.
 *
 * Pure and import-light, so every rule here is asserted without a database.
 */

import { JOURNEY_CHECK_MARKER } from "@/lib/outstation/decision-note";
import { isOutstationClaimUndecided } from "@/lib/outstation/undecided-claim";

/** What a clean trip's eligibility says. The calculation's ONLY "eligible" sentence. */
export const OUTSTATION_ELIGIBLE_LOCATION_REASON = "Captured location is eligible for outstation calculation.";

/**
 * What the calculation writes when a train or bus claim has no ticket. It only ever downgrades an
 * ELIGIBLE claim to `needs_review` (service.ts, calculateOutstationExpense), so a claim carrying
 * this exact sentence was eligible in every other respect.
 */
export const OUTSTATION_TICKET_EVIDENCE_REQUIRED_REASON =
  "Ticket-based trips require attachment evidence before the request can move forward.";

/** The hold the submit path writes onto a ticketless claim that arrived through the offline route. */
export const OUTSTATION_OFFLINE_TICKET_HOLD_REASON =
  "This train or bus claim was captured offline and could not carry its ticket attachment, so it is held for Super Admin review before it moves to payroll.";

/** Refused when the claim already carries a ticket — this tool fills a gap, it never adds a second copy. */
export const MISSING_TICKET_ALREADY_ATTACHED_MESSAGE =
  "This claim already has its ticket attached. To add another leg, use Add tickets on the Expense Dashboard.";

/** Refused for a car trip (or anything that is not a train or bus). */
export const MISSING_TICKET_WRONG_TRANSPORT_MESSAGE = "Only a train or bus claim carries a ticket.";

/**
 * May the employee attach a missing ticket to this claim of his? All three must hold:
 *   - a train or bus claim (a car trip's evidence is its photos);
 *   - nobody has decided it yet (the 2026-10-19 rule: after HR decides, nothing can be added);
 *   - it carries no ticket at all — the gap, never a second copy of one already there.
 */
export function canAttachMissingOutstationTicket(input: {
  status: unknown;
  ticketAttachmentCount: number | null | undefined;
  transportationType: unknown;
}): boolean {
  const transport = String(input.transportationType ?? "").trim().toLowerCase();
  if (transport !== "train" && transport !== "bus") return false;
  if (!isOutstationClaimUndecided(input.status)) return false;
  const count = Number(input.ticketAttachmentCount ?? 0);
  return !(Number.isFinite(count) && count > 0);
}

/**
 * The eligibility once the ticket is attached. Only the ticket downgrade is undone: a claim held
 * for any OTHER reason (distance, governorate, not eligible) keeps exactly what it had.
 */
export function eligibilityAfterMissingTicketAttached<S extends string>(input: {
  eligibilityReason: string | null | undefined;
  eligibilityStatus: S;
}): { eligibilityReason: string; eligibilityStatus: S | "eligible" } {
  const reason = String(input.eligibilityReason ?? "").trim();
  if (input.eligibilityStatus === "needs_review" && reason === OUTSTATION_TICKET_EVIDENCE_REQUIRED_REASON) {
    return { eligibilityReason: OUTSTATION_ELIGIBLE_LOCATION_REASON, eligibilityStatus: "eligible" };
  }
  return { eligibilityReason: String(input.eligibilityReason ?? ""), eligibilityStatus: input.eligibilityStatus };
}

/** The sentence the approver reads once the employee has supplied the ticket. */
export function missingTicketAttachedSentence(attachedOnLabel: string, fileCount: number): string {
  const files = fileCount === 1 ? "1 file" : `${fileCount} files`;
  return `The employee attached the ticket on ${attachedOnLabel} (${files}), after the claim arrived without it.`;
}

/**
 * The approval reason once the ticket is attached. The offline hold sentence is REPLACED by the
 * attached sentence (it is no longer true); with no hold sentence, the attached one is added to the
 * free text. Either way it stays AHEAD of the system's "Journey check:" group, which must remain
 * the tail (decision-note.ts) so a re-priced journey can still replace it.
 */
export function approvalReasonAfterMissingTicketAttached(
  reason: string | null | undefined,
  attachedSentence: string,
): string {
  const text = String(reason ?? "");
  if (text.includes(OUTSTATION_OFFLINE_TICKET_HOLD_REASON)) {
    return text.replace(OUTSTATION_OFFLINE_TICKET_HOLD_REASON, attachedSentence);
  }
  const cut = text.indexOf(JOURNEY_CHECK_MARKER);
  const head = (cut >= 0 ? text.slice(0, cut) : text).trim();
  const tail = cut >= 0 ? text.slice(cut).trim() : "";
  return [head, attachedSentence, tail].filter(Boolean).join(" ");
}
