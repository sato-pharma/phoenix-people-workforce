import { canonicalHrIdKey } from "@/lib/hr-id";
import type { MarketAwarenessApproverSlot } from "@/lib/market-awareness/approvers";
import type { MarketAwarenessActivity } from "@/lib/market-awareness/types";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";

/**
 * Who is told what, and when.
 *
 * THE CONVERSATION IS NOT BUILT HERE. Any comment thread on an activity goes through
 * `src/lib/conversations/notify.ts`, which is the owner's own 2026-09-03 rule — email to the
 * submitter, CC the sender and every participant, in-app and Telegram to everyone except the author.
 * Re-implementing that addressing would make it two rules within a year.
 *
 * WHAT THIS MODULE ADDS is the one-off announcement on CEO approval: the National Sales Manager,
 * the SFE Manager and Finance, for execution. In-app, Telegram and email (owner answer 42).
 *
 * TWO AUDIENCES WERE REMOVED ON 2026-09-12, both at the owner's instruction and both for the same
 * reason. Every district manager in the region was told, and so was the area's own Medical Rep;
 * neither holds a `market_awareness` grant any more, so the announcement would have handed each of
 * them a link to a page that refuses them. A notification is a door: closing the sidebar link while
 * this one still fired would have left the door standing.
 *
 * Best-effort by contract. The activity row is already committed by the time this runs, so a
 * delivery failure is logged and swallowed — never thrown back into the write path, where it would
 * roll back an approval the CEO actually made.
 */

export const MARKET_AWARENESS_NOTIFICATION_MODULE = "market_awareness";

function activityLabel(activity: MarketAwarenessActivity): string {
  const name = activity.title?.trim();
  return name ? `${activity.activityType.name} — ${name}` : activity.activityType.name;
}

function moneyLabel(activity: MarketAwarenessActivity): string {
  const amount = activity.approvedCost ?? activity.estimatedCost;
  // Human-readable, never a raw number with no currency. Cairo formatting, EGP.
  return `${amount.toLocaleString("en-EG", { maximumFractionDigits: 2 })} ${activity.currency}`;
}

export type ApprovalAudience = {
  /** Everyone who will actually be told, de-duplicated by canonical HR id. */
  recipientHrIds: string[];
};

/**
 * The informed set: whoever the caller resolves by role — the NSM, the SFE Manager and Finance.
 *
 * NOBODY ELSE, and two names that used to be here are the reason this comment is long.
 *
 * NO DISTRICT MANAGER. Every DM in the region used to be told — owner answer 32, deliberately wider
 * than the single DM of the area — and on 2026-09-12 the owner hid the module from district managers
 * altogether.
 *
 * NO MEDICAL REP either. The area's own rep was the first name on this list (owner answer 42) and
 * came off the same day, at the owner's instruction: "no hide from medical rep". He never held a
 * `market_awareness` grant at all, so the notice he was getting pointed at a page that redirected
 * him the moment he opened it — a door with nothing behind it, arriving by three channels.
 *
 * So the activity itself is no longer read here: every recipient now comes from the caller's role
 * lookup, and this function's whole job is to de-duplicate them by canonical HR id. It was async
 * while it still resolved the region's managers from the database; it reads nothing now, and a
 * function that returns a promise for no reason is a missing `await` waiting to happen. Left
 * exported and separate so the audience can be asserted without a database.
 *
 * `loadRegionManagers` is still the source of `activity.districtManagers` in the service — the
 * activity screen names the DMs of the region to the people who CAN see it. Naming a manager is not
 * notifying him, and the same holds for the rep named on the activity.
 */
export function resolveApprovalAudience(
  hrIds: Array<string | null | undefined> = [],
): ApprovalAudience {
  const seen = new Set<string>();
  const recipientHrIds: string[] = [];
  for (const hrId of hrIds) {
    if (!hrId) continue;
    const key = canonicalHrIdKey(hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipientHrIds.push(hrId);
  }

  return { recipientHrIds };
}

/**
 * Who must be told that a step is waiting on them.
 *
 * Split out so it can be asserted without a database, the same reason `resolveConversationAudience`
 * is. It mirrors `canDecideStep` deliberately: the notification must never reach someone the
 * decision route would then refuse, and it must never miss somebody who can act.
 *
 * AT THE GROUP STEP IT IS EVERY MEMBER WHO HAS NOT YET ANSWERED — the whole point of the parallel
 * rewrite is that two or three people are asked at once, and telling only the first of them
 * reproduces the sequential chain the owner replaced. Whoever has already approved is left out: a
 * second notice for a decision he has made reads as his answer not having registered.
 *
 * At the CEO step the group is irrelevant, and the step is role-based, so the CEO seat holders are
 * the whole list.
 *
 * An empty result means the step has no holder. The caller reports the count rather than assuming
 * it landed.
 */
export function resolvePendingDecisionRecipients(input: {
  ceoHrIds: Array<string | null | undefined>;
  managerHrId: string | null;
  approvers?: Array<Pick<MarketAwarenessApproverSlot, "assignedHrId" | "decision">>;
  step: "group" | "manager" | "ceo";
}): string[] {
  const candidates =
    input.step === "ceo"
      ? input.ceoHrIds
      : input.step === "group"
        ? (input.approvers ?? [])
            .filter((slot) => slot.decision === null)
            .map((slot) => slot.assignedHrId)
        : [input.managerHrId];

  const seen = new Set<string>();
  const recipientHrIds: string[] = [];
  for (const hrId of candidates) {
    if (!hrId) continue;
    const key = canonicalHrIdKey(hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipientHrIds.push(hrId);
  }
  return recipientHrIds;
}

/**
 * Fired on every hand-off: an activity has arrived at a step and somebody must act on it.
 *
 * THIS IS THE ONE THAT WAS MISSING. The module shipped with an approvals inbox and no way for
 * anyone to learn there was something in it — two real requests sat untouched on 2026-09-07,
 * submitted at 09:52 and 09:56 Cairo, because nothing told Rasha or the CEO they existed. A queue
 * nobody is sent to is a queue nobody reads.
 *
 * Addressed by SLOT at the group step and by ROLE at the CEO step, matching `canDecideStep`
 * exactly — the notification must never reach someone the decision route would then refuse, and it
 * must never miss somebody who can act. `recipientHrIds` empty means the step has no holder; the
 * caller reports the count rather than assuming it landed.
 */
export async function notifyDecisionPending(input: {
  activity: MarketAwarenessActivity;
  actionUrl: string;
  /** The CEO seat holders, resolved by the caller from the role directory. Ignored at the group step. */
  ceoHrIds: Array<string | null | undefined>;
  step: "group" | "manager" | "ceo";
}): Promise<{ notified: number }> {
  const { activity, step } = input;

  try {
    const recipientHrIds = resolvePendingDecisionRecipients({
      approvers: activity.approvers,
      ceoHrIds: input.ceoHrIds,
      managerHrId: activity.managerHrId,
      step,
    });
    if (recipientHrIds.length === 0) return { notified: 0 };

    const where = [activity.areaName ?? activity.areaCode, activity.regionName ?? activity.regionCode]
      .filter(Boolean)
      .join(", ");

    await createSystemNotificationForRecipients(
      {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: "market_awareness_decision_pending",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} is waiting for your decision`,
        message:
          `${activity.requesterName ?? activity.requesterHrId} submitted ${activityLabel(activity)} ` +
          `for ${where} on ${activity.primaryLine.name}, starting ${activity.startDate}. ` +
          `Requested value ${moneyLabel(activity)}.`,
        metadata: {
          activityCode: activity.activityCode,
          areaCode: activity.areaCode,
          regionCode: activity.regionCode,
          step,
        },
        telegram: { ctaLabel: "Open the approvals inbox", ctaUrl: input.actionUrl },
      },
      recipientHrIds,
    );

    return { notified: recipientHrIds.length };
  } catch (error) {
    // Swallowed: the submission is already committed, and an undelivered notification must never
    // undo it. It is logged so a silent queue is visible in the error monitor rather than inferred
    // from nobody acting — which is exactly how this gap went unnoticed.
    logError("Market Awareness pending-decision notification failed", {
      labels: {
        event: "market_awareness_pending_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
        step,
      },
      error,
    });
    return { notified: 0 };
  }
}

/**
 * Fired when a decider sends it back or refuses it — the requester is the only recipient.
 *
 * Returned and rejected are one notification with different words, not two paths: both mean the
 * request stopped moving and only the person who raised it can act next. The decider's comment is
 * carried IN FULL, never trimmed to a preview — the owner's standing rule, and a half-sentence is
 * what forces someone back into the app to find out what was actually asked of them.
 */
export async function notifyActivityReturned(input: {
  activity: MarketAwarenessActivity;
  actionUrl: string;
  comment: string | null;
  deciderName: string | null;
  rejected: boolean;
}): Promise<{ notified: number }> {
  const { activity } = input;

  try {
    if (!activity.requesterHrId) return { notified: 0 };

    const decider = input.deciderName?.trim() || "Your reviewer";
    const verb = input.rejected ? "was not approved" : "was sent back for changes";
    const note = input.comment?.trim();

    await createSystemNotificationForRecipients(
      {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: input.rejected
          ? "market_awareness_activity_rejected"
          : "market_awareness_activity_returned",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} ${verb}`,
        message:
          `${decider} ${input.rejected ? "did not approve" : "sent back"} ${activityLabel(activity)}` +
          (note ? `: "${note}"` : "."),
        metadata: {
          activityCode: activity.activityCode,
          rejected: input.rejected,
        },
        telegram: { ctaLabel: "Open the activity", ctaUrl: input.actionUrl },
      },
      [activity.requesterHrId],
    );

    return { notified: 1 };
  } catch (error) {
    logError("Market Awareness return notification failed", {
      labels: {
        event: "market_awareness_return_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
      },
      error,
    });
    return { notified: 0 };
  }
}

/**
 * Fired when a member of the group freezes the request — the requester is the only recipient.
 *
 * A HOLD IS NOT A RETURN AND MUST NOT READ LIKE ONE. Nothing is being asked of the requester and
 * there is nothing for him to edit; the request is simply parked, and it will move again when the
 * person who parked it says so. Without this he watches it stop with no reason given anywhere —
 * the same failure a return with no comment produces, which is why the reason is required at the
 * constraint, at the function and here.
 *
 * The other approvers are deliberately NOT told. They cannot act on a frozen request, and a notice
 * about something they are not being asked to do is the noise that makes people stop reading them.
 */
export async function notifyActivityHeld(input: {
  activity: MarketAwarenessActivity;
  actionUrl: string;
  holderName: string | null;
  reason: string | null;
}): Promise<{ notified: number }> {
  const { activity } = input;

  try {
    if (!activity.requesterHrId) return { notified: 0 };

    const holder = input.holderName?.trim() || "One of your approvers";
    const reason = input.reason?.trim();

    await createSystemNotificationForRecipients(
      {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: "market_awareness_activity_held",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} is on hold`,
        message:
          `${holder} put ${activityLabel(activity)} on hold` +
          (reason ? `: "${reason}".` : ".") +
          " Nothing is needed from you — it will move again when the hold is lifted.",
        metadata: {
          activityCode: activity.activityCode,
          heldBy: activity.heldByHrId,
        },
        telegram: { ctaLabel: "Open the activity", ctaUrl: input.actionUrl },
      },
      [activity.requesterHrId],
    );

    return { notified: 1 };
  } catch (error) {
    logError("Market Awareness hold notification failed", {
      labels: {
        event: "market_awareness_hold_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
      },
      error,
    });
    return { notified: 0 };
  }
}

/**
 * Fired once, when the CEO approves. Recipients can comment on the activity but never approve it —
 * their matrix grant is `read` only, so this notification cannot become an authority they lack.
 *
 * Neither district managers nor the area's Medical Rep are recipients since 2026-09-12 — see
 * `resolveApprovalAudience` for why.
 */
export async function notifyActivityApproved(input: {
  activity: MarketAwarenessActivity;
  /** NSM, SFE Manager and Finance HR ids, resolved by the caller from the role directory. */
  roleRecipientHrIds: Array<string | null | undefined>;
  actionUrl: string;
}): Promise<{ notified: number }> {
  const { activity } = input;

  try {
    const audience = resolveApprovalAudience(input.roleRecipientHrIds);
    if (audience.recipientHrIds.length === 0) {
      return { notified: 0 };
    }

    const where = [activity.areaName ?? activity.areaCode, activity.regionName ?? activity.regionCode]
      .filter(Boolean)
      .join(", ");

    await createSystemNotificationForRecipients(
      {
        module: MARKET_AWARENESS_NOTIFICATION_MODULE,
        eventType: "market_awareness_activity_approved",
        category: "market_awareness",
        recordId: activity.id,
        actionUrl: input.actionUrl,
        title: `${activityLabel(activity)} approved in ${where}`,
        message:
          `${activity.requesterName ?? activity.requesterHrId} had ${activityLabel(activity)} approved ` +
          `for ${where} on ${activity.primaryLine.name}, starting ${activity.startDate}. ` +
          `Approved value ${moneyLabel(activity)}.`,
        metadata: {
          activityCode: activity.activityCode,
          areaCode: activity.areaCode,
          regionCode: activity.regionCode,
          line: activity.primaryLine.name,
          startDate: activity.startDate,
        },
        telegram: { ctaLabel: "Open the activity", ctaUrl: input.actionUrl },
      },
      audience.recipientHrIds,
    );

    return { notified: audience.recipientHrIds.length };
  } catch (error) {
    // Swallowed on purpose: the approval is already committed, and an undelivered notification must
    // never undo a decision the CEO made.
    logError("Market Awareness approval notification failed", {
      labels: {
        event: "market_awareness_approval_notify_failed",
        activity_id: activity.id,
        activity_code: activity.activityCode,
      },
      error,
    });
    return { notified: 0 };
  }
}
