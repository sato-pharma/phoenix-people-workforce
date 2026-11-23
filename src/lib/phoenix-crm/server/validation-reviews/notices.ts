/**
 * Place checks — the notices a waiting review raises and withdraws, and the rep's Validate again.
 * Moved out of `validation-reviews.ts` unchanged on 23 Nov 2026, so no file of Place checks is over 400
 * lines; that file re-exports everything here that it exported, so import from it.
 */

import { raiseApproval } from "@/lib/approvals/raise-approval";
import { withdrawInAppNotificationsByEventKeyPrefix } from "@/lib/notifications/in-app";
import { phoenixCrmChannels } from "@/lib/notifications/phoenix-crm-channel-guard";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import { logError } from "@/lib/observability/log";
import { territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import type { PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { throwIfError } from "@/lib/phoenix-crm/server/db";
import { notifyPhoenixCrm, PHOENIX_CRM_NOTIFICATION_CATEGORY, PHOENIX_CRM_NOTIFICATION_MODULE } from "@/lib/phoenix-crm/server/notifications";
import { loadPeopleNames, nameOf } from "@/lib/phoenix-crm/server/people";
import { parseValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { reviewNoticeKey, type Row, text, VALIDATION_REVIEWS_PATH } from "@/lib/phoenix-crm/server/validation-reviews/shared";

/** Answer the "waiting for you" notice of one review — when the system approved it first. Never throws. */
export async function withdrawValidationReviewWaiting(reviewId: string): Promise<void> {
  if (!reviewId) return;
  await withdrawInAppNotificationsByEventKeyPrefix(reviewNoticeKey(reviewId)).catch(() => undefined);
}

/**
 * A held place is waiting, to every Super Admin — which in practice is the owner alone.
 *
 * 🔴 EMAIL, IN-APP AND TELEGRAM (and the phone), BY HIS OWN ORDER (owner, 2026-10-05, naming the page:
 * "when an update here /admin/field-crm/validation-reviews I must be notified by email, in app and
 * telegram"). This is the module's one email that goes nowhere but to him, so the volume argument that
 * keeps the rest of Phoenix CRM email-free does not apply. The channels are NOT written out here: they
 * come from `phoenixCrmChannels`, whose allowlist is the single place the module's email exception is
 * declared and the only place the guard will honour — naming them here would be a second truth that
 * the guard silently overrules.
 *
 * Never throws: the place is already saved, and a notice that cannot be sent must not turn the rep's
 * save into an error.
 */
export async function notifyValidationReviewWaiting(input: { customerName: string; seat: OrgSeat; repHrId: string; reviewId: string | null }): Promise<void> {
  if (!input.reviewId) return;
  try {
    const [{ hrIds }, names] = await Promise.all([resolveHrIdsForRole("Super Admin", "Phoenix CRM — validation reviews"), loadPeopleNames([input.repHrId])]);
    const recipients = hrIds.filter((hrId) => !hrId.startsWith("TEST-"));
    if (recipients.length === 0) return;
    const rep = nameOf(names, input.repHrId, "A rep");
    await raiseApproval({ module: "phoenix_crm", step: "waiting" }, { via: "notices", notice: {
        actionUrl: VALIDATION_REVIEWS_PATH,
        category: PHOENIX_CRM_NOTIFICATION_CATEGORY,
        channels: phoenixCrmChannels("validation_review_waiting"),
        eventType: "validation_review_waiting",
        message: `${rep} validated ${input.customerName} (${territoryName(input.seat)}), and the system could not confirm it — against Google Maps, or from its signboard. It waits for your decision.`,
        metadata: { idempotencyKey: reviewNoticeKey(input.reviewId), seatId: input.seat.seatId },
        module: PHOENIX_CRM_NOTIFICATION_MODULE,
        priority: "normal",
        recordId: input.reviewId,
        subjectHrId: input.repHrId,
        telegram: { ctaLabel: "Open the reviews", ctaUrl: VALIDATION_REVIEWS_PATH },
        title: `Place to check: ${input.customerName}`,
      }, recipientHrIds: recipients });
  } catch (error) {
    logError("Phoenix CRM validation review notice failed", { error, labels: { event: "phoenix_crm_validation_review_notify_failed" } });
  }
}

// ── Telling the rep what is wrong with his photo (2026-10-08) ───────────────────────────────────

/** Every "validate this one again" notice ever raised about one customer — every review, both worlds. */
export function validationNotConfirmedKeyPrefix(customerId: string): string {
  return `phoenix_crm:validation_not_confirmed:${customerId}:`;
}

/**
 * Withdraw the rep's "validate again" notice about one customer — when he has validated him again,
 * and when the refusal is taken back. A bell left asking for something already done is the exact
 * frustration the owner named. Never throws.
 */
export async function withdrawValidationNotConfirmed(customerId: string): Promise<void> {
  if (!customerId) return;
  await withdrawInAppNotificationsByEventKeyPrefix(validationNotConfirmedKeyPrefix(customerId)).catch(() => undefined);
}

/**
 * Tell the rep, in-app only, that one customer is back under To validate and what is wrong with his
 * photo. Built from what `phoenix_crm_decide_validation_review` returns, so no second read is made.
 *
 * 🔴 ONLY WHEN THE CUSTOMER IS REALLY BACK UNDER TO VALIDATE. A rejected SECOND place of a customer who
 * keeps another one changes nothing on his list, and a bell about it would be a judgement with nothing
 * for him to do — the very thing Golden Rule #1 keeps off his phone. Never throws.
 */
export async function tellRepValidateAgain(viewer: PhoenixCrmViewer, result: Row): Promise<void> {
  try {
    const customerId = text(result.customer_id);
    const repHrId = text(result.rep_hr_id);
    const reviewId = text(result.review_id);
    const seat = viewer.org.seats.get(String(result.seat_id));
    if (!customerId || !repHrId || !reviewId || !seat) return;
    const { data, error } = await getSupabaseAdmin().from("phoenix_crm_customers").select("status").eq("id", customerId).maybeSingle();
    throwIfError(error);
    if ((data as Row | null)?.status !== "pending") return;
    await notifyPhoenixCrm(
      {
        kind: "validation_not_confirmed",
        seat,
        repHrId,
        customerId,
        customerName: text(result.customer_name) ?? "A customer",
        reviewId,
        reason: parseValidationRefusalReason(result.refusal_reason),
        // Phoenix CRM validation audit, 14 Nov 2026: a place has ONE review row for all time, so a place
        // refused, brought back and refused again raised its second notice on the first one's key. A key
        // that already reached him is never delivered twice and nothing un-archives a notice he cleared,
        // so the second refusal reached nobody. The refusal's own instant rides on the end of the key, as
        // a building's does (`tellSeatedRepsValidateAgain`); the function returns no `decided_at`, so it
        // is read from the clock. The prefix `withdrawValidationNotConfirmed` clears by is untouched.
        attempt: new Date().toISOString(),
      },
      result.is_test === true,
    );
  } catch (error) {
    logError("Phoenix CRM validate-again notice failed", { error, labels: { event: "phoenix_crm_validate_again_notify_failed" } });
  }
}
