/**
 * Place checks — the decision on a review, and the Super Admin's restore.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { forbiddenError, validationError } from "@/lib/http/api-errors";
import { afterResponse } from "@/lib/http/after-response";
import { withdrawInAppNotificationsByEventKeyPrefix } from "@/lib/notifications/in-app";
import { logError } from "@/lib/observability/log";
import { cleanText } from "@/lib/phoenix-crm/entry-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { canDecideValidationReviews, canRestoreValidation, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { callPhoenixCrm } from "@/lib/phoenix-crm/server/db";
import { keepReviewAdviceQuietly } from "@/lib/phoenix-crm/server/stored-advice";
import { tellDecisionComment } from "@/lib/phoenix-crm/server/place-notes";
import { followLineTwinCopiesQuietly, shareAcrossLinesQuietly } from "@/lib/phoenix-crm/server/line-twins";
import { restampVisitLocationsQuietly } from "@/lib/phoenix-crm/server/visit-locations";
import { parseValidationRefusalReason, VALIDATION_REASON_REQUIRED } from "@/lib/phoenix-crm/validation-feedback";
import { parseDoctorFullName } from "@/lib/phoenix-crm/pm-name-rules";
import { invalidateMyMapSnapshotCache } from "@/lib/dashboard/invalidation";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { refuseApprovalOfShortName, reviewCustomerId, reviewNoticeKey, type Row, text } from "@/lib/phoenix-crm/server/validation-reviews/shared";
import { tellRepValidateAgain, withdrawValidationNotConfirmed } from "@/lib/phoenix-crm/server/validation-reviews/notices";
import { adviceOnWaitingReview } from "@/lib/phoenix-crm/server/validation-reviews/queue";

/**
 * Approve or reject one held place. Approve validates a held customer in the rep's own name; reject
 * retires the place and, when it was his only one, sends him back to To validate.
 *
 * 🔴 A REJECTION NOW CARRIES WHAT IS WRONG WITH THE PHOTO, AND THE REP IS TOLD IT (owner, 2026-10-08:
 * "tell the rep why"). The reason is REQUIRED on a reject and never asked on an approve; it is one of
 * the eight in validation-feedback.ts, and the rep reads its sentence about his own picture. The comment
 * is OPTIONAL and always was on this path; since 2026-11-01 one that is written reaches the rep and his
 * manager on either decision (`tellDecisionComment`), by role and never by name.
 *
 * 🔴 AND A REJECT IS ACCEPTED ON A REVIEW THIS PAGE ALREADY APPROVED (owner, 2026-10-15: "make admin
 * able to reject validation even if approved before"). `phoenix_crm_decide_validation_review` lets
 * that one case through its `review_decided` guard since migration 20261015212903, so the undo of an
 * approval runs the SAME reject as a held place's — same events, same restamp, same one sentence to
 * the rep — and the review row KEEPS the evidence the system held it on. Approving an approved review,
 * and anything at all on a rejected one, still raise `review_decided`; taking a REJECTION back is
 * `restoreValidation` below.
 */
export async function decideValidationReview(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ reviewId: string; status: "approved" | "rejected"; waitingForBuilding: boolean; reopened: boolean }> {
  if (!canDecideValidationReviews(viewer)) throw forbiddenError("Only the Super Admin decides these.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.reviewId)) throw validationError("Choose the place to decide.");
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) throw validationError("Choose approve or reject.");
  const refusalReason = decision === "reject" ? parseValidationRefusalReason(body.refusalReason) : null;
  if (decision === "reject" && !refusalReason) throw validationError(VALIDATION_REASON_REQUIRED);
  const reviewId = String(body.reviewId).toLowerCase();
  if (decision === "approve") await refuseApprovalOfShortName(await reviewCustomerId(reviewId));
  // What the system advised, read while the review still waits, and kept once the decision has landed.
  const adviceThen = await adviceOnWaitingReview(reviewId);
  // `review_not_found` and `review_decided` come back worded by the module's refusal table (db.ts).
  const result = await callPhoenixCrm<Row>("phoenix_crm_decide_validation_review", {
    p: { review_id: reviewId, actor_hr_id: viewer.hrId, decision, note: cleanText(body.note, 500), refusal_reason: refusalReason },
  });
  await keepReviewAdviceQuietly(reviewId, adviceThen);
  // 🔴 A SEND-BACK KEEPS EVERY VISIT'S EARLIER DISTANCE (owner, 19 Nov 2026: "Keep earlier distances").
  // A reject used to measure all of the customer's visits again against whatever places he had left, so
  // a doctor with a second clinic had every visit he was seen at in the first one turned "far" from the
  // second: 4 of ماريان مدحت كرم's and 10 of اسامة سعيد عبدالوهاب's that night, put back from a backup
  // by hand. The visits stay exactly as they were measured; taking the rejection back
  // (`restoreValidation`) is what measures them again, against the place that came back.
  // An approved doctor is validated on the other two lines of his area too (owner, 2026-11-12;
  // line-twins.ts), after the reply.
  if (decision === "approve") {
    await afterResponse("phoenix-crm: share an approved validation across the lines", () => shareAcrossLinesQuietly(text(result.customer_id)));
  }
  // Phoenix CRM validation audit, 14 Nov 2026: an approval that validates the customer answers the
  // "validate again" notice an earlier refusal left in the rep's bell. Only the door and the take-back
  // of a rejection withdrew it, so a customer approved here kept a bell asking for a photo already
  // accepted. Never throws.
  // 🔴 AN APPROVAL BEHIND A BUILDING STILL BEING CHECKED WAITS FOR THE BUILDING (owner, 14 Nov 2026).
  // The review is approved and the customer stays under To validate until his building is approved, which
  // then validates him (migration 20261114062049). His photo is accepted all the same, so the bell goes.
  const waitingForBuilding = decision === "approve" && result.waiting_for_building === true;
  if (decision === "approve" && (result.validated === true || waitingForBuilding)) await withdrawValidationNotConfirmed(String(result.customer_id));
  // The "waiting for you" notice is answered.
  await withdrawInAppNotificationsByEventKeyPrefix(reviewNoticeKey(reviewId)).catch(() => undefined);
  // And the rep is told what is wrong with his photo — in-app only, about his picture alone.
  if (decision === "reject") await tellRepValidateAgain(viewer, result);
  // A rejected place takes its copies on the other lines with it (the database trigger); their doctors
  // are offered to any twin still validated, after the reply (owner, 2026-11-12). Their visits keep their
  // distances, as this customer's do (owner, 19 Nov 2026).
  if (decision === "reject") {
    await afterResponse("phoenix-crm: follow a rejected place's line copies", async () => {
      const { data: rejected } = await getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("place_id").eq("id", reviewId).maybeSingle();
      const rejectedPlace = text((rejected as Row | null)?.place_id);
      if (rejectedPlace) await followLineTwinCopiesQuietly([rejectedPlace], viewer.config.settings, { retired: true, keepDistances: true });
    });
  }
  // The comment written with it, which the RPC's answer does not name the place of.
  if (cleanText(body.note, 500)) {
    const { data: reviewed, error: reviewedError } = await getSupabaseAdmin().from("phoenix_crm_validation_reviews").select("place_id").eq("id", reviewId).maybeSingle();
    if (reviewedError) logError("Phoenix CRM decision comment could not find its place", { error: reviewedError, labels: { event: "phoenix_crm_decision_comment_failed" } });
    const reviewedPlace = text((reviewed as Row | null)?.place_id);
    if (reviewedPlace) await tellDecisionComment(viewer, "place", reviewedPlace, body.note);
  }
  // A rejected place leaves My map; its landing cards read again rather than waiting out their minute.
  invalidateMyMapSnapshotCache("phoenix-crm-decide-validation-review");
  return { reviewId, status: decision === "approve" ? "approved" : "rejected", waitingForBuilding, reopened: result.reopened === true };
}

/**
 * Take a rejection back (owner, 2026-10-03: "add the option to approve after reject"). The place comes
 * back, and the customer is validated again in the REP's own name where the rejection had sent him to
 * To validate — he did validate it, and a reversal does not take that away from him.
 *
 * The place's one review row turns from `rejected` to `approved` (it is UNIQUE per place), carrying who
 * rejected it and why in its `google` payload, beside the four events the list keeps. The rep's list
 * simply stops saying "Validate again", with no word about a person (golden rule #1).
 *
 * 🔴 THE NOTE IS OPTIONAL SINCE 2026-10-15 (owner: "admin comment is optional"). It was required here
 * and on the refusal below, on the reasoning that a decision reversed in silence cannot be understood
 * months later — and what that produced was a dash: 22 of the module's first 24 refusals carried the
 * single character `-`. Who reversed it, when, and what the rejection had said are all on the record
 * either way (`decided_by_hr_id`, `decided_at`, and the `google` payload the function carries over).
 */
export async function restoreValidation(
  viewer: PhoenixCrmViewer,
  raw: unknown,
): Promise<{ reviewId: string; validated: boolean; renamed: boolean; waitingForBuilding: boolean }> {
  // 🔴 THE SUPER ADMIN ALONE, AND NEVER BLOCKED (owner, 2026-11-10: "make the administrator able to approve
  // a rejected validation from the SFE in place checks but the SFE cannot; the administrator is never
  // blocked"). The short-name rule that greys out Approve does NOT stand in his way here: he approves the
  // name as it stands, or sends the three names he corrected it to (`nameParts`) and the customer is
  // renamed in the same transaction (his "Both", the same day). The rep still writes all three names before
  // a visit to a short-named doctor saves — that gate is the visit's, not this one.
  if (!canRestoreValidation(viewer)) throw forbiddenError("Only the Super Admin approves a validation after it was rejected.");
  const body = (raw && typeof raw === "object" ? raw : {}) as Row;
  if (!isUuid(body.reviewId)) throw validationError("Choose the rejection to take back.");
  const note = cleanText(body.note, 500);
  let name: string | null = null;
  if (body.nameParts !== undefined && body.nameParts !== null) {
    // Held to the same three-name rules a rep's own boxes are (no title, no place word, one name a box).
    const parsed = parseDoctorFullName(body.nameParts, null);
    if (!parsed.ok) throw validationError(parsed.error);
    name = parsed.value;
  }

  // `review_not_found`, `review_not_rejected` and `place_not_retired` come back worded by the
  // module's refusal table (db.ts).
  const result = await callPhoenixCrm<Row>("phoenix_crm_restore_validation", {
    p:
      name === null
        ? { review_id: String(body.reviewId).toLowerCase(), actor_hr_id: viewer.hrId, note }
        : { review_id: String(body.reviewId).toLowerCase(), actor_hr_id: viewer.hrId, note, name },
  });
  // The place is measurable again, so every visit to the customer gets its distance back.
  await restampVisitLocationsQuietly({
    seatId: String(result.seat_id),
    isTest: result.is_test === true,
    customerId: String(result.customer_id),
    actorHrId: viewer.hrId,
    settings: viewer.config.settings,
    scope: "all",
  });
  // Validated again, so validated on the other two lines of his area too (line-twins.ts).
  await afterResponse("phoenix-crm: share a restored validation across the lines", () => shareAcrossLinesQuietly(text(result.customer_id)));
  // The refusal is taken back, so the bell that asked him to capture it again goes with it.
  await withdrawValidationNotConfirmed(String(result.customer_id));
  await tellDecisionComment(viewer, "place", String(result.place_id), note);
  return {
    reviewId: String(result.review_id),
    validated: result.validated === true,
    renamed: result.renamed === true,
    // His building is still being checked: the place is back and he counts once the building is approved.
    waitingForBuilding: result.waiting_for_building === true,
  };
}
