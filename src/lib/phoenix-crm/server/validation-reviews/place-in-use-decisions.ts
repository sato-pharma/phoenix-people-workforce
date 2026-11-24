/**
 * Place checks — rejecting or approving a place already in use.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { conflictError, forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { canDecideValidationReviews, canRestoreValidation, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { approvalLockFor } from "@/lib/phoenix-crm/server/super-admin-approval";
import { SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT } from "@/lib/phoenix-crm/super-admin-approval-rules";
import { callPhoenixCrm, throwIfError } from "@/lib/phoenix-crm/server/db";
import { tellDecisionComment } from "@/lib/phoenix-crm/server/place-notes";
import { followLineTwinCopiesQuietly, shareAcrossLinesQuietly } from "@/lib/phoenix-crm/server/line-twins";
import { parseValidationRefusalReason, PLACE_GONE_CODE, PLACE_RETIRED_CODE, VALIDATION_REASON_REQUIRED } from "@/lib/phoenix-crm/validation-feedback";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { isRecord, refuseApprovalOfShortName, type Row, text } from "@/lib/phoenix-crm/server/validation-reviews/shared";
import { tellRepValidateAgain, withdrawValidationNotConfirmed, withdrawValidationReviewWaiting } from "@/lib/phoenix-crm/server/validation-reviews/notices";
import { decideValidationReview } from "@/lib/phoenix-crm/server/validation-reviews/decisions";

/**
 * What a review row's `google` record held, as the one thing a hand decision keeps of it.
 *
 * Phoenix CRM validation audit, 14 Nov 2026 (see `refuseValidatedPlace`). The record is kept WITHOUT
 * its own `before`, so the column never grows a chain. One exception, and it is the point of keeping
 * anything: when the record on file is itself a hand decision (`refused_by_admin`,
 * `confirmed_by_admin`) that already carries the system's evidence, that evidence is carried forward
 * rather than replaced by a stub that says only who pressed the button last.
 */
function evidenceToKeep(google: unknown): Row | null {
  if (!isRecord(google)) return null;
  const byHand = google.reason === "refused_by_admin" || google.reason === "confirmed_by_admin";
  const kept = byHand && isRecord(google.before) ? google.before : google;
  const flat = Object.fromEntries(Object.entries(kept).filter(([key]) => key !== "before"));
  return Object.keys(flat).length > 0 ? flat : null;
}

/**
 * Refuse one validation the system never questioned.
 *
 * 🔴 THE NOTE IS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"); the REASON — the one
 * sentence the rep is told — is still required. The note was mandatory because a hand refusal carries
 * no Google evidence of its own, and the answer to a mandatory field nobody reads was a dash in 22 of
 * the first 24 refusals.
 */
export async function refuseValidatedPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; reopened: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.placeId)) throw validationError("Choose the place to refuse.");
  // What is wrong with the photo, required because the rep is always told it (2026-10-08). The comment
  // beside it is the decider's to leave empty; one that is written reaches the rep and his manager.
  const refusalReason = parseValidationRefusalReason(body.refusalReason);
  if (!refusalReason) throw validationError(VALIDATION_REASON_REQUIRED);
  const note = cleanText(body.note, 500);
  const placeId = String(body.placeId).toLowerCase();

  const { data, error } = await getSupabaseAdmin()
    .from("phoenix_crm_places")
    .select("id, seat_id, customer_id, is_test, status, created_by_hr_id")
    .eq("id", placeId)
    .maybeSingle();
  throwIfError(error);
  const place = data as Row | null;
  if (!place) throw notFoundError("This place is no longer there.", PLACE_GONE_CODE);
  if (place.status !== "active") throw conflictError("This place is already retired.", PLACE_RETIRED_CODE);

  // The review the automatic check would have written, had this customer been in its scope.
  //
  // 🔴 An UPSERT on place_id, never a plain insert: `phoenix_crm_validation_reviews_place_idx` is
  // UNIQUE on place_id, so a place that was already held once — an AM one the check held and then
  // approved — has a row, and inserting a second died on 23505. It is put back to `pending` (and
  // `decided_at` cleared with it, or the table's own CHECK refuses the row) so the shared reject
  // below is what decides it, exactly as it decides an automatic hold.
  //
  // Phoenix CRM validation audit, 14 Nov 2026: the upsert replaced the row's `google` column whole, so
  // refusing here a place the system had once held threw away what it was held on (the listings, the
  // sign as read). What the row held is read first and kept under `before` — one level, never a `before`
  // inside a `before` (`evidenceToKeep`). Every reader of this column reads its top level, which is
  // still the hand refusal, so nothing on a screen changes. Still two steps, as it always was.
  const earlier = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .select("id, google, status, decided_by_hr_id")
    .eq("place_id", placeId)
    .maybeSingle();
  throwIfError(earlier.error);
  // 🔴 WHAT THE SUPER ADMIN APPROVED, ONLY THE SUPER ADMIN REFUSES (owner, 2026-11-16: "when super admin
  // approve something sfe or whoever cannot reject it back bec its approved by admin"). Asked HERE, before
  // the upsert below puts the review back to pending and clears who approved it — after that the database's
  // own guard can no longer see the approval (it still sees a place the Super Admin created himself).
  const earlierRow = earlier.data as Row | null;
  const lockedFor = await approvalLockFor(viewer);
  if (lockedFor(earlierRow?.status === "approved" ? earlierRow.decided_by_hr_id : null, place.created_by_hr_id)) {
    throw forbiddenError(SUPER_ADMIN_APPROVAL_IS_FINAL_TEXT);
  }
  // 🔴 AN APPROVED PLACE IS REJECTED ON ITS OWN ROW, NEVER BY PUTTING IT BACK TO PENDING (owner, 17 Nov
  // 2026, the audit's decision paths; the rule "an approved validation can be rejected on its own row").
  // A customer seated in a building and approved more than 14 days ago reached the board with no review
  // id, so his Reject posted here, and the upsert below overwrote who approved him and when. Whatever
  // screen sends it, an approval is now rejected by the review route, which keeps that record.
  if (earlierRow?.status === "approved" && typeof earlierRow.id === "string") {
    const decided = await decideValidationReview(viewer, { reviewId: earlierRow.id, decision: "reject", note, refusalReason });
    return { placeId, reopened: decided.reopened };
  }
  const before = evidenceToKeep((earlier.data as Row | null)?.google);
  const upserted = await getSupabaseAdmin()
    .from("phoenix_crm_validation_reviews")
    .upsert(
      {
        seat_id: String(place.seat_id),
        customer_id: String(place.customer_id),
        place_id: placeId,
        is_test: place.is_test === true,
        kind: "validation",
        status: "pending",
        google: { reason: "refused_by_admin", refused_by_hr_id: viewer.hrId, ...(before ? { before } : {}) },
        created_by_hr_id: String(place.created_by_hr_id),
        decided_by_hr_id: null,
        decided_at: null,
        decision_note: null,
      },
      { onConflict: "place_id" },
    )
    .select("id")
    .single();
  throwIfError(upserted.error);
  const reviewId = String((upserted.data as Row).id);

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision: "reject", note, refusal_reason: refusalReason },
  });
  // 🔴 NO VISIT IS MEASURED AGAIN — a send-back keeps every visit's earlier distance (owner, 19 Nov
  // 2026; the reason is above the same step in `decideValidationReview`).
  // He is told what is wrong with his photo, exactly as an automatic hold's rejection tells him — one
  // notice, one wording, and nothing in it says a person looked.
  await tellRepValidateAgain(viewer, result);
  await tellDecisionComment(viewer, "place", placeId, note);
  // Its copies on the other lines were removed with it (the database trigger), after the reply; their
  // visits keep their distances too.
  await afterResponse("phoenix-crm: follow a refused place's line copies", () =>
    followLineTwinCopiesQuietly([placeId], viewer.config.settings, { retired: true, keepDistances: true }),
  );
  return { placeId, reopened: result.reopened === true };
}

/**
 * Confirm one validation the system could not (owner, 2026-10-17: *"make me able to approve"*, asked on
 * the Not confirmed photographs — "I can read them. So why you cannot?").
 *
 * The mirror of `refuseValidatedPlace`: the SAME review row the automatic check writes, in the rep's
 * name, put to `pending` and then decided by the SAME `phoenix_crm_decide_validation_review` approve —
 * so a confirmation is one more `validation_review_approved` event, and the place leaves Not confirmed
 * because a review now exists for it (`reviewed`). The customer is already validated, so nothing the
 * rep sees changes and he is told nothing (golden rule #1) — unless a comment was written with it, which
 * he and his manager read (owner, 2026-11-01).
 *
 * A place someone has already decided is left exactly as it is, and a place the door is still holding
 * is approved on its own review, keeping the evidence it was held on.
 */
export async function approveValidatedPlace(viewer: PhoenixCrmViewer, raw: unknown): Promise<{ placeId: string; approved: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.placeId)) throw validationError("Choose the place to approve.");
  const note = cleanText(body.note, 500);
  const placeId = String(body.placeId).toLowerCase();

  const [placeRead, reviewRead] = await Promise.all([
    getSupabaseAdmin().from("phoenix_crm_places").select("id, seat_id, customer_id, is_test, status, created_by_hr_id").eq("id", placeId).maybeSingle(),
    getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("id, status").eq("place_id", placeId).maybeSingle(),
  ]);
  throwIfError(placeRead.error);
  throwIfError(reviewRead.error);
  const place = placeRead.data as Row | null;
  if (!place) throw notFoundError("This place is no longer there.", PLACE_GONE_CODE);
  if (place.status !== "active") throw conflictError("This place is already retired.", PLACE_RETIRED_CODE);
  const existing = reviewRead.data as Row | null;
  // Decided already — by him, or by the system's own reading. Nothing to add but the comment he wrote.
  if (existing && existing.status !== "pending") {
    await tellDecisionComment(viewer, "place", placeId, note);
    return { placeId, approved: false };
  }
  // The Super Admin is never blocked (owner, 24 Nov 2026); no short name refuses him.
  if (!canRestoreValidation(viewer)) await refuseApprovalOfShortName(place.customer_id);

  let reviewId = existing ? String(existing.id) : null;
  if (!reviewId) {
    // 🔴 An UPSERT on place_id, for the reason `refuseValidatedPlace` gives: the index is UNIQUE.
    const upserted = await getSupabaseAdmin()
      .from("phoenix_crm_validation_reviews")
      .upsert(
        {
          seat_id: String(place.seat_id),
          customer_id: String(place.customer_id),
          place_id: placeId,
          is_test: place.is_test === true,
          kind: "validation",
          status: "pending",
          google: { reason: "confirmed_by_admin", confirmed_by_hr_id: viewer.hrId },
          created_by_hr_id: String(place.created_by_hr_id),
          decided_by_hr_id: null,
          decided_at: null,
          decision_note: null,
        },
        { onConflict: "place_id" },
      )
      .select("id")
      .single();
    throwIfError(upserted.error);
    reviewId = String((upserted.data as Row).id);
  }

  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision: "approve", note, refusal_reason: null },
  });
  // A held place's "waiting for you" notice is answered.
  await withdrawValidationReviewWaiting(reviewId);
  // Phoenix CRM validation audit, 14 Nov 2026: and where this approval is what validated the customer
  // (a place the door was still holding), the "validate again" notice in the rep's bell goes with it.
  if (result?.validated === true) await withdrawValidationNotConfirmed(String(place.customer_id));
  await tellDecisionComment(viewer, "place", placeId, note);
  await afterResponse("phoenix-crm: share a confirmed validation across the lines", () => shareAcrossLinesQuietly(text(place.customer_id)));
  return { placeId, approved: true };
}
