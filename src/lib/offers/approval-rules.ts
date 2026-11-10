/**
 * The HR Manager's approval of a job offer — the PURE rules (owner, 2026-11-10: "she never automatic
 * sent. My approval first"). No database and no server import, so the Offers screen draws its
 * buttons from the same answers the routes enforce. The notices and the permission read live in
 * `approval.ts`, which re-exports everything here.
 */

import type { OfferStatus } from "@/lib/offers/types";

/** What Send does for this person: email the candidate, or park the offer for the HR Manager. */
export type OfferSendPath = "send" | "request_approval";

/** The pure decision behind Send. Kept apart from the route so it can be pinned without a database. */
export function offerSendPath(canApprove: boolean): OfferSendPath {
  return canApprove ? "send" : "request_approval";
}

/** Why this person's Send cannot act on an offer of this status, or null when it can. */
export function offerSendRefusal(status: OfferStatus, canApprove: boolean): string | null {
  if (status === "draft") return null;
  if (status === "pending_approval") {
    return canApprove ? null : "This offer is already waiting for the HR Manager's approval. It goes to the candidate once approved.";
  }
  return "This offer has already been sent. Use Resend on its row to send the same letter again.";
}

/** Why this person cannot reject this offer back to draft, or null when they can. */
export function offerReturnRefusal(status: OfferStatus, canApprove: boolean): string | null {
  if (!canApprove) return "Only the HR Manager can reject an offer waiting for approval.";
  if (status !== "pending_approval") return "This offer is not waiting for approval, so there is nothing to reject.";
  return null;
}

/** A status a person may NOT set by hand on the status PATCH: approval moves only through its buttons. */
export function offerStatusMoveRefusal(current: OfferStatus, next: OfferStatus): string | null {
  if (next === "pending_approval") return "An offer goes for approval through Send, not by setting its status.";
  // "Sent" is what the Send button writes once the email has left on the HR Manager's word; setting
  // it by hand on an unsent offer would record a send that never happened and skip his approval.
  if (next === "sent" && (current === "draft" || current === "pending_approval")) {
    return "An offer is marked sent only by sending it. Press Send — it goes to the HR Manager for approval first.";
  }
  // Nothing has reached the candidate, so he cannot have accepted or declined it, and marking it
  // "sent" would skip the HR Manager's approval altogether. Withdrawing it is still allowed.
  if (current === "pending_approval" && next !== "withdrawn") {
    return "This offer is waiting for the HR Manager's approval and has not reached the candidate. Approve it, reject it, or withdraw it.";
  }
  return null;
}

/** The status as a person reads it — never the raw key. */
export function offerStatusLabel(status: OfferStatus): string {
  switch (status) {
    case "pending_approval":
      return "Awaiting approval";
    case "draft":
      return "Draft";
    case "sent":
      return "Sent";
    case "accepted":
      return "Accepted";
    case "declined":
      return "Declined";
    case "withdrawn":
      return "Withdrawn";
    default:
      return String(status);
  }
}
