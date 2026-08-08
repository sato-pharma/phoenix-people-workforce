import type { DirectOrderApprovalDetail, DirectOrderRequest } from "@/lib/direct-orders/types";
import { canonicalHrIdKey } from "@/lib/hr-id";

// ─────────────────────────────────────────────────────────────────────────────
// When may the pharmacy-validation capture appear? (spec A2)
//
// This lived inline in the ADMIN detail page only, and the portal page — the one a Medical Rep or
// District Manager actually reaches — never got a copy. The result was a door that existed in the
// code and could not be opened by anyone who needed it: every rep is redirected INTO the portal, so
// no rep could ever see the capture. On 2026-08-05 that showed up as 11 held orders worth 509,736
// EGP with ZERO validation requests submitted against them, which reads like nobody tried when in
// fact nobody could.
//
// One exported predicate, used by both routes, so the two cannot drift again.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Only the REQUESTER, only on their own HELD order, and only while the pharmacy is still
 * unconfirmed.
 *
 * Not the approver reading the same page: the evidence has to come from the person who stood in
 * front of the pharmacy, and the GPS check is run against THEIR area. An approver's capture would
 * be a photo of a place they were never at, which is worse than no evidence because it looks like
 * proof.
 */
export function canCaptureDirectOrderValidation(
  viewerHrId: string | null | undefined,
  detail: DirectOrderApprovalDetail | null,
): boolean {
  if (!detail?.pharmacy) return false;
  const viewer = canonicalHrIdKey(viewerHrId ?? "");
  if (!viewer) return false;
  if (viewer !== canonicalHrIdKey(detail.request.requesterHrId ?? "")) return false;
  if (detail.request.status !== "held") return false;
  return detail.pharmacy.verificationStatus === "pending_review";
}

/**
 * May this viewer see the AI's storefront sign-check note (spec E2), as opposed to just the
 * photo/GPS themselves?
 *
 * The requester does NOT see it, even on their own tracking view (owner rule, 2026-08-08): they
 * already know what they photographed, and the note was written for an adjudicator's judgement
 * call, not as a verdict on the submitter's own evidence. Everyone else who can already open the
 * request (approvers, company-wide roles, the requester's management chain) sees it unchanged —
 * this narrows only the ONE field, never the evidence card's existence.
 */
export function canViewDirectOrderEvidenceAiNote(
  viewerHrId: string | null | undefined,
  request: Pick<DirectOrderRequest, "requesterHrId">,
): boolean {
  const viewer = canonicalHrIdKey(viewerHrId ?? "");
  if (!viewer) return false;
  return viewer !== canonicalHrIdKey(request.requesterHrId ?? "");
}
