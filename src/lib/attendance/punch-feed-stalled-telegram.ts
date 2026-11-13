// THE TELEGRAM HALF of the punch-feed alarm (integration audit, 13 Nov 2026, finding ISS-034).
//
// WHY IT EXISTS. `runAttendanceIngestionAlert` (ingestion-health.ts) already notices a working day
// that passed with no fingerprint punch stored, and tells the Super Admin in-app and by push. Those
// two are read only by someone who has Phoenix open. A feed that stops is exactly the fault that
// happens while nobody is looking, and every other operator alarm here (a stranded job, a database
// restart, a stuck notification drain) also reaches Telegram. This one did not.
//
// WHAT IT DOES NOT CHANGE. The judgement is not made here: the caller decides the feed is stalled
// (a whole working day missed, weekend and holiday aware) and has already checked the admin toggle.
// The in-app and push notice keeps its own event, module and channel list, pinned by
// tests/attendance-alert-no-email.test.ts. Holding the deduction run while the feed is down is a
// money decision and is deliberately not part of this.
//
// A SEPARATE SEND, NOT ONE MORE CHANNEL ON THE EXISTING NOTICE, for two reasons. Telegram is governed
// per module, and the module switched on for it is "system": the same notice on module "attendance"
// would be dropped by resolveTelegramGovernance with nothing red. And the existing notice names its
// recipients through metadata, which the Telegram path does not read; this names each person.
//
// NEVER EMAIL, and do not "fix" that back: the event is listed in operator-watch-channel-guard.ts so
// a failed Telegram send is not re-sent as an email, which is the rule the in-app half already holds
// (owner, 2026-08-08 and 2026-08-09).

import { buildPunchFeedStalledMessage, PUNCH_FEED_STALLED_TITLE } from "@/lib/attendance/punch-feed-stalled-message";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";

const AUDIENCE_KEY = "attendance_ingestion_alert" as const;
const EVENT_TYPE = "attendance_punch_feed_stalled";
const ACTOR = "attendance-ingestion-alert";
const SCREEN_URL = "/attendance/device-user-mapping";

export type PunchFeedStalledTelegramResult = { delivered: number; reason?: string };

/**
 * Tell each person in the alarm's audience on Telegram, once per Cairo day. Never throws: the alarm
 * it rides on runs inside the five-minute notification pass, which must not be stopped by it.
 */
export async function sendPunchFeedStalledTelegram(input: {
  /** The Cairo day the alarm is raised on; one message per person per day. */
  dayIso: string;
  lastIngestedAt: string | null;
  missedWorkingDays: number;
  priority: "high" | "normal";
}): Promise<PunchFeedStalledTelegramResult> {
  try {
    const { recipients } = await resolveNotificationPersonRecipients(AUDIENCE_KEY, "Punch feed alarm recipients");
    if (recipients.length === 0) return { delivered: 0, reason: "no recipients" };

    const message = buildPunchFeedStalledMessage({
      lastIngestedAt: input.lastIngestedAt,
      missedWorkingDays: input.missedWorkingDays,
    });

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        const result = await createSystemNotification({
          actionUrl: SCREEN_URL,
          actorId: ACTOR,
          // Telegram alone: the in-app and push copies already went with the notice this rides on.
          channels: ["telegram"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            idempotencyKey: `attendance-punch-feed-stalled:${input.dayIso}:${recipient.hrId}`,
            lastIngestedAt: input.lastIngestedAt,
            missedWorkingDays: input.missedWorkingDays,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the alarm.
          module: "system",
          priority: input.priority,
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open Device User Mapping", ctaUrl: SCREEN_URL },
          title: PUNCH_FEED_STALLED_TITLE,
        });
        if (result.deliveries.some((delivery) => delivery.status === "sent" || delivery.status === "pending")) {
          delivered += 1;
        }
      }),
    );
    return { delivered };
  } catch (error) {
    logError("The punch feed alarm could not be sent on Telegram", {
      error,
      labels: { event: "attendance_punch_feed_telegram_failed" },
    });
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error" };
  }
}
