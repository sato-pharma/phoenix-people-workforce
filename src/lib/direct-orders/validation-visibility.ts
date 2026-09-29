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

/**
 * May this viewer see the "not GPS field-validated" line about the order's venue?
 *
 * APPROVER-ONLY, NEVER THE PORTAL — owner's ruling, 2026-09-29, the same day he asked for the line
 * at all: *"make the not-field-validated line approver-only, not the portal."* So it is withheld on
 * two counts, and either one is enough:
 *
 *   • the EMPLOYEE PORTAL shell, whoever is in it. The portal is the field's own world — every rep
 *     and every portal-mode manager is redirected into it, and the admin twin bounces them back —
 *     so nav mode is exactly the line between the two audiences, not a proxy for one.
 *   • the order's OWN REQUESTER, even in the admin shell. He is not an approver of his own order,
 *     and a sentence saying nobody ever captured the venue he raised it on reads as a verdict on
 *     him. Same reasoning as the AI sign-check note above (owner rule, 2026-08-08), reached again.
 *
 * The line judges the EVIDENCE, not the work, and it is for the person deciding. It changes no
 * number, no status and no wording anywhere the requester can see — the venue's own validation
 * state, its photo and its pin all stay on his tracking view exactly as before.
 *
 * Gated in the SERVICE as well as the screen: withheld means the fact never enters the portal's
 * payload at all, rather than being rendered and hidden.
 */
export function canViewDirectOrderFieldEvidenceGap(input: {
  viewerHrId: string | null | undefined;
  requesterHrId: string | null | undefined;
  /** `resolveNavigationMode(access)` — "employee-portal" is the rep's shell. */
  navigationMode: string;
}): boolean {
  if (input.navigationMode === "employee-portal") return false;
  const viewer = canonicalHrIdKey(input.viewerHrId ?? "");
  if (!viewer) return false;
  return viewer !== canonicalHrIdKey(input.requesterHrId ?? "");
}
