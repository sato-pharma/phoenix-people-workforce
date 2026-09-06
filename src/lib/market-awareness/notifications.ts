import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadRegionManagers } from "@/lib/market-awareness/geography";
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
 * WHAT THIS MODULE ADDS is the one-off announcement on CEO approval: every district manager in the
 * region for the chosen line, the National Sales Manager, the SFE Manager, the area's Medical Rep,
 * and Finance for execution. In-app, Telegram and email (owner answer 42).
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
  districtManagerHrIds: string[];
  repHrId: string | null;
  /** Everyone who will actually be told, de-duplicated by canonical HR id. */
  recipientHrIds: string[];
};

/**
 * The informed set. Every DM in the REGION for the chosen line — the owner's answer 32, which is
 * wider than the single DM of the area — plus the area's rep.
 *
 * A DM seat with nobody in it yields no HR id and is simply absent from the recipients. That is a
 * real vacancy rather than a lookup failure, and the caller reports the count so a shorter list than
 * the screen promised is visible rather than silent.
 */
export async function resolveApprovalAudience(
  activity: MarketAwarenessActivity,
  extraHrIds: Array<string | null | undefined> = [],
): Promise<ApprovalAudience> {
  const managers = await loadRegionManagers(
    activity.primaryLine.lineCode,
    activity.regionCode,
  );
  const districtManagerHrIds = managers
    .map((manager) => manager.dmHrId)
    .filter((hrId): hrId is string => Boolean(hrId));

  const repHrId = activity.rep.hrId;

  const seen = new Set<string>();
  const recipientHrIds: string[] = [];
  for (const hrId of [...districtManagerHrIds, repHrId, ...extraHrIds]) {
    if (!hrId) continue;
    const key = canonicalHrIdKey(hrId);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    recipientHrIds.push(hrId);
  }

  return { districtManagerHrIds, repHrId, recipientHrIds };
}

/**
 * Fired once, when the CEO approves. Recipients can comment on the activity but never approve it —
 * their matrix grant is `read` only, so this notification cannot become an authority they lack.
 */
export async function notifyActivityApproved(input: {
  activity: MarketAwarenessActivity;
  /** NSM, SFE Manager and Finance HR ids, resolved by the caller from the role directory. */
  roleRecipientHrIds: Array<string | null | undefined>;
  actionUrl: string;
}): Promise<{ notified: number; districtManagers: number; repNotified: boolean }> {
  const { activity } = input;

  try {
    const audience = await resolveApprovalAudience(activity, input.roleRecipientHrIds);
    if (audience.recipientHrIds.length === 0) {
      return { notified: 0, districtManagers: 0, repNotified: false };
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

    return {
      notified: audience.recipientHrIds.length,
      districtManagers: audience.districtManagerHrIds.length,
      repNotified: Boolean(audience.repHrId),
    };
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
    return { notified: 0, districtManagers: 0, repNotified: false };
  }
}
