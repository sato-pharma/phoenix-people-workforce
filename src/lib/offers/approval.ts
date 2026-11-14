/**
 * The HR Manager's approval of a job offer (owner, 2026-11-10, verbatim):
 *
 *   "When the talent acquisition sends a job offer, it doesn't send automatic. It comes to me, the HR
 *    manager, for my approval. If I approved, the email is pumped. If I reject or leave it pending,
 *    it leaves as it is. … I have the option to edit anything in the offer. But she never automatic
 *    sent. My approval first."
 *
 * ── The rule ──
 * Send is one button for everybody, and what it does depends on who presses it:
 *   - somebody WITHOUT `offers:approve` (Talent Acquisition) → the offer becomes `pending_approval`
 *     and nothing is emailed. The HR Manager is told in-app, by push and on Telegram — never email.
 *   - somebody WITH `offers:approve` (the Super Admin — the HR Manager; Talent Acquisition's bundle
 *     never carries it, `src/lib/auth/hr-functions.ts`) → the letter is emailed. On a pending offer
 *     that press IS the approval.
 * While it waits, only he may edit it; his Reject returns it to draft with his reason, unsent; and
 * an offer he leaves alone stays exactly where it is. Nothing here ever sends on a timer.
 *
 * NOTHING HERE THROWS INTO ITS CALLER from the notices: they run after the status write, inside
 * `afterResponse`, and a notice that failed must never undo or block the decision.
 */

import { raiseApproval } from "@/lib/approvals/raise-approval";
import type { OfferRecord } from "@/lib/offers/types";
import { canAccess, type AccessContext } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import {
  logNotificationSendFailure,
  type SystemNotificationChannel,
} from "@/lib/notifications/system";

export const OFFER_APPROVAL_MODULE = "offers" as const;
export const OFFER_APPROVAL_REQUESTED_EVENT = "offer_approval_requested" as const;
export const OFFER_APPROVAL_RETURNED_EVENT = "offer_approval_returned" as const;
export const OFFER_APPROVAL_APPROVED_EVENT = "offer_approval_approved" as const;

/** The role that approves: the Super Admin seat, which is the HR Manager. */
export const OFFER_APPROVER_ROLE = "Super Admin" as const;

export {
  offerReturnRefusal,
  offerSendPath,
  offerSendRefusal,
  offerStatusLabel,
  offerStatusMoveRefusal,
  type OfferSendPath,
} from "@/lib/offers/approval-rules";

/** In-app, push and Telegram. Never email — this is an internal "please decide", not correspondence. */
export const OFFER_APPROVAL_CHANNELS: readonly SystemNotificationChannel[] = ["in_app", "push", "telegram"];

/** Whether this person approves offers — and therefore whether their Send reaches the candidate. */
export async function canApproveOffers(access: AccessContext): Promise<boolean> {
  return canAccess(access, "offers", "approve");
}

const NOT_RECORDED = "Not recorded";
function stated(value: string | number | null | undefined): string {
  const text = String(value ?? "").trim();
  return text.length > 0 ? text : NOT_RECORDED;
}

function money(value: number): string {
  return Number.isFinite(value) && value > 0 ? `EGP ${Math.round(value).toLocaleString("en-US")}` : NOT_RECORDED;
}

type OfferNoticeFields = Pick<OfferRecord, "candidateName" | "id" | "reference" | "startDate" | "title" | "totalMonthly">;

export function offerApprovalRequestTitle(offer: Pick<OfferRecord, "candidateName">): string {
  return `Job offer awaiting your approval: ${stated(offer.candidateName)}`;
}

export function offerApprovalRequestMessage(offer: OfferNoticeFields): string {
  return `${stated(offer.candidateName)} — ${stated(offer.title)}, ${money(offer.totalMonthly)} a month, starting ${stated(offer.startDate)}. Nothing has been sent to the candidate. Open Job Offers to edit it, approve and send it, or reject it.`;
}

function offerDetails(offer: OfferNoticeFields): Array<{ label: string; value: string }> {
  return [
    { label: "Candidate", value: stated(offer.candidateName) },
    { label: "Role", value: stated(offer.title) },
    { label: "Total monthly", value: money(offer.totalMonthly) },
    { label: "Start date", value: stated(offer.startDate) },
    { label: "Offer reference", value: stated(offer.reference) },
  ];
}

/** Tell the HR Manager an offer is waiting for him. Swallows every failure. */
export async function announceOfferAwaitingApproval(offer: OfferNoticeFields, requestedBy: string | null): Promise<void> {
  const offerId = String(offer?.id ?? "").trim();
  if (!offerId) return;
  try {
    const approvers = await resolveHrIdsForRole(OFFER_APPROVER_ROLE, "Offer approval — approvers");
    if (approvers.hrIds.length === 0) {
      logError("An offer is waiting for approval but no HR Manager could be found to tell", {
        error: new Error(`offer ${offerId}`),
        labels: { event: "offer_approval_no_approver" },
      });
      return;
    }
    await raiseApproval({ module: "offer", step: "waiting" }, { via: "notices", notice: {
        actionUrl: "/offers",
        actorId: requestedBy,
        channels: [...OFFER_APPROVAL_CHANNELS],
        eventType: OFFER_APPROVAL_REQUESTED_EVENT,
        message: offerApprovalRequestMessage(offer),
        metadata: {
          authorizedRecipient: true,
          details: offerDetails(offer),
          // Per request, not per offer: an offer rejected and sent again is a new question for him.
          idempotencyKey: `offer-approval-requested:${offerId}:${Date.now()}`,
        },
        module: OFFER_APPROVAL_MODULE,
        priority: "high",
        recordId: offerId,
        title: offerApprovalRequestTitle(offer),
      }, recipientHrIds: approvers.hrIds });
  } catch (error) {
    logNotificationSendFailure("offerApproval.announceAwaitingApproval", error);
  }
}

/** Tell whoever asked that the HR Manager decided. In-app and push only. Swallows every failure. */
export async function announceOfferApprovalDecision(
  offer: OfferNoticeFields,
  decision: { by: string | null; outcome: "approved" | "returned"; reason?: string | null; requestedBy: string | null },
): Promise<void> {
  const offerId = String(offer?.id ?? "").trim();
  const requester = String(decision.requestedBy ?? "").trim();
  // Nobody asked (he sent his own draft), or he is the one who asked: there is nobody to tell.
  if (!offerId || !requester || requester.toUpperCase() === String(decision.by ?? "").trim().toUpperCase()) return;
  const approved = decision.outcome === "approved";
  const reason = String(decision.reason ?? "").trim();
  try {
    await raiseApproval({ decision: approved ? "approved" : "rejected", module: "offer", step: "decided" }, { via: "notices", notice: {
        actionUrl: "/offers",
        actorId: decision.by,
        channels: ["in_app", "push"],
        eventType: approved ? OFFER_APPROVAL_APPROVED_EVENT : OFFER_APPROVAL_RETURNED_EVENT,
        message: approved
          ? `The HR Manager approved the offer for ${stated(offer.candidateName)} (${stated(offer.title)}) and it has been sent to the candidate.`
          : `The HR Manager rejected the offer for ${stated(offer.candidateName)} (${stated(offer.title)}). It is back in draft and nothing was sent.${reason ? ` The HR Manager's note: ${reason}` : ""}`,
        metadata: {
          authorizedRecipient: true,
          details: [...offerDetails(offer), ...(reason ? [{ label: "HR Manager's note", value: reason }] : [])],
          idempotencyKey: `offer-approval-${decision.outcome}:${offerId}:${Date.now()}`,
        },
        module: OFFER_APPROVAL_MODULE,
        priority: "normal",
        recordId: offerId,
        title: approved
          ? `Offer approved and sent: ${stated(offer.candidateName)}`
          : `Offer rejected — back to draft: ${stated(offer.candidateName)}`,
      }, recipientHrIds: [requester] });
  } catch (error) {
    logNotificationSendFailure("offerApproval.announceDecision", error);
  }
}
