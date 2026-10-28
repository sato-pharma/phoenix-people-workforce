// The message the database host sampler sends when the production database server is nearly out of
// memory or its system disk is nearly full. The rule and the wording are pure, in db-host-metrics.ts;
// this file is the IO around them, on the same path as the database restart alarm
// (database-restart-alert.ts).
//
// DELIBERATELY NO EMAIL, for that alarm's two reasons: no feature may add an outbound email, and an alarm
// about the database must not travel by an outbox that lives in that same database. In-app + Telegram +
// push on the technical-health audience, retargeted or silenced from /admin/notification-recipients.
//
// ONE MESSAGE PER KIND PER CAIRO DAY — the in-process rule already says so, and the idempotency key says it
// again, so a redeploy in the middle of the day cannot send the same standing fault twice.

import { writeAuditLog } from "@/lib/admin/audit";
import { cairoDay, dbHostAlarmMessage, type DbHostAlarmKind, type DbHostSample } from "@/lib/observability/db-host-metrics";
import { logError } from "@/lib/observability/log";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const ACTOR = "database-host-watch";
const SCREEN_URL = "/admin/system-audit";

/** Never throws: it runs on the minute the database is at its least healthy. */
export async function sendDbHostAlarm(kind: DbHostAlarmKind, sample: DbHostSample): Promise<{ delivered: number }> {
  try {
    const day = cairoDay(Date.now());
    const { message, title } = dbHostAlarmMessage(kind, sample);

    // logError, so the alarm is findable in `railway logs` and in app_error_events whether or not a
    // message went out.
    logError(title, {
      error: new Error(message),
      labels: { alarm: kind, event: "db_host_alarm" },
    });

    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Database host alarm recipients",
    );
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: `observability.db_host_${kind}`,
        entityType: "notification",
        newValues: { failClosed: true, warnings },
        summary: "Database host alarm skipped — no active recipient resolved for the configured audience.",
      });
      return { delivered: 0 };
    }

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: SCREEN_URL,
          actorId: ACTOR,
          // No email — see the file header.
          channels: ["in_app", "telegram", "push"],
          eventType: `database_host_${kind}`,
          message,
          metadata: { idempotencyKey: `database-host-${kind}:${day}:${recipient.hrId}` },
          // "system" is the module enabled for Telegram; an unknown module fails closed and drops the alarm.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open the System Audit", ctaUrl: SCREEN_URL },
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: `observability.db_host_${kind}`,
      entityType: "notification",
      newValues: {
        delivered,
        memAvailableMb: sample.memAvailableMb,
        rootDiskFreeMb: sample.rootDiskFreeMb,
        swapUsedMb: sample.swapUsedMb,
        warnings,
      },
      summary: `Database host alarm (${kind}) delivered to ${delivered} recipient(s).`,
    });
    return { delivered };
  } catch (error) {
    logError("Database host alarm failed", { error, labels: { alarm: kind, event: "db_host_alarm_failed" } });
    return { delivered: 0 };
  }
}
