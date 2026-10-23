import { writeAuditLog } from "@/lib/admin/audit";
import { describeDrainHealth, type DrainHealthVerdict } from "@/lib/notifications/drain-health";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";

/**
 * Tells a human, in-app + Telegram, the moment the notification drain strands due work — the exact
 * shape `drain-health.ts` was built to detect (see that file's header for the 2026-08-14 13-day
 * freeze). Before this, that shape reached only the `drain_stranded` ERROR log and the external
 * Healthchecks.io dead-man's-switch — real, but both require someone to be watching a dashboard or
 * an inbox. This is the same pattern `held-notification-alert.ts` already uses (and the reconciliation
 * breach alert used until it was retired on 2026-10-23) for "a background job found something wrong".
 *
 * Reuses the `weekly_system_health_digest` audience key — the existing "technical/system health"
 * recipient list — rather than inventing a new one: the owner can already retarget or silence it
 * from /admin/notification-recipients, with no new key and no migration.
 *
 * Deliberately no email: this alert can fire because the notification pipeline itself is the thing
 * not delivering, so an alert that depends on that same channel would not be an alert.
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "notification_drain_stranded";

export type DrainHealthAlertResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
};

/** Cairo calendar day — the idempotency bucket, so a persisting strand alerts once per day, not once per 5-minute tick. */
function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** Pure message builder — no IO, so it is unit-testable without a database. */
export function buildDrainStrandedMessage(verdict: DrainHealthVerdict): string {
  return [
    "🛑 The notification drain has due work it is not delivering.",
    "",
    describeDrainHealth(verdict),
    "",
    "Queued email/Telegram/push retries are not going out, and this does not clear on its own — the",
    "2026-08-14 freeze sat exactly like this for 13 days behind a green cron. Investigate the drain.",
  ].join("\n");
}

/**
 * Best-effort — never throws. A failed alert must not turn a stranded drain into a second,
 * self-inflicted incident; the `drain_stranded` ERROR log and the Healthchecks ping are unaffected
 * either way.
 *
 * Idempotency is bucketed per Cairo day AND per exact set of stranded queues, so a strand that
 * persists across many 5-minute ticks alerts once a day, and a NEWLY stranded queue (or a strand
 * that clears and reappears with a different combination) still gets through instead of being
 * swallowed by an earlier key.
 */
export async function notifyDrainStranded(verdict: DrainHealthVerdict): Promise<DrainHealthAlertResult> {
  try {
    if (verdict.healthy) return { delivered: 0, reason: "healthy", skipped: true };

    const strandedQueues = verdict.stranded.map((reading) => reading.queue).sort();
    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Drain-stranded alert recipients",
    );

    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: "notification-drain-cron",
        entityId: "notifications.drain_stranded",
        entityType: "notification",
        newValues: { failClosed: true, strandedQueues, warnings },
        summary: "Drain-stranded alert skipped — no active recipient resolved for the configured audience.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const message = buildDrainStrandedMessage(verdict);
    const idempotencyBase = `notification-drain-stranded:${cairoDayKey()}:${strandedQueues.join(",")}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/system-audit",
          actorId: "notification-drain-cron",
          // No email — see file header. In-app + Telegram + push only.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            strandedQueues,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the alert.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open the System Audit", ctaUrl: "/admin/system-audit" },
          title: `Notification drain stranded — ${strandedQueues.join(", ")}`,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: "notification-drain-cron",
      entityId: "notifications.drain_stranded",
      entityType: "notification",
      newValues: { delivered, strandedQueues, warnings },
      summary: `Drain-stranded alert delivered to ${delivered} recipient(s).`,
    });

    return { delivered, skipped: false };
  } catch (error) {
    // Swallow: a stranded-drain alert must never depend on itself to be delivered.
    logError("Drain-stranded alert failed to dispatch", {
      error,
      labels: { event: "drain_stranded_alert_failed" },
    });
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
