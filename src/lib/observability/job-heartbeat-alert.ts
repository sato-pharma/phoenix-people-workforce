import { writeAuditLog } from "@/lib/admin/audit";
import {
  describeJobHeartbeats,
  strandedJobSlugs,
  type JobHeartbeatVerdict,
} from "@/lib/observability/job-heartbeat-assess";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";

/**
 * Tells a human, in-app + Telegram, that a scheduled job has stopped reporting.
 *
 * This is the third channel, and it is the one that matters. The register itself writes an ERROR
 * log, and Healthchecks turns a dashboard red — both real, and both require someone to already be
 * watching. The notification outbox sat blocked for THIRTEEN DAYS behind a green cron in August
 * precisely because nothing pushed the finding at a person (AGENTS.md §3).
 *
 * Reuses the `weekly_system_health_digest` audience — the existing "technical/system health"
 * recipient list — exactly as `drain-health-alert.ts` does. No new key, no migration, and the
 * owner can already retarget or silence it from /admin/notification-recipients.
 *
 * DELIBERATELY NO EMAIL, and do not "fix" that back. Two independent reasons, either sufficient:
 * this alert can fire because the notification pipeline is itself the thing not running, so an
 * emailed alert would depend on the channel it is reporting broken; and the owner's standing rule
 * is that no feature may add an outbound email.
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "scheduled_job_stranded";
const ACTOR = "job-heartbeat-sweep";

export type JobHeartbeatAlertResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
};

/** Cairo calendar day — the idempotency bucket. */
function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** Pure message builder — no IO, so it is unit-testable without a database. */
export function buildJobStrandedMessage(verdict: JobHeartbeatVerdict): string {
  const strandedCount = verdict.stranded.length;
  const lead =
    strandedCount > 0
      ? "🛑 A scheduled job has stopped reporting."
      : "⚠️ A scheduled job ran and reported a failure.";
  return [
    lead,
    "",
    describeJobHeartbeats(verdict),
    "",
    "A job that stops does not announce itself — this alert is the announcement. Nothing here",
    "clears on its own.",
  ].join("\n");
}

/**
 * Best-effort — never throws. A failed alert must not turn a stranded job into a second,
 * self-inflicted incident; the ERROR log and the register row are unaffected either way.
 *
 * Idempotency is bucketed per Cairo day AND per exact set of problem slugs, so a job that stays
 * stranded across many 15-minute sweeps alerts once a day, while a NEWLY stranded job still gets
 * through instead of being swallowed by an earlier key.
 */
export async function notifyJobsStranded(verdict: JobHeartbeatVerdict): Promise<JobHeartbeatAlertResult> {
  try {
    if (verdict.healthy) return { delivered: 0, reason: "healthy", skipped: true };

    const problemSlugs = strandedJobSlugs(verdict);
    const { recipients, warnings } = await resolveNotificationPersonRecipients(
      AUDIENCE_KEY,
      "Stranded-job alert recipients",
    );

    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "observability.scheduled_job_stranded",
        entityType: "notification",
        newValues: { failClosed: true, problemSlugs, warnings },
        summary: "Stranded-job alert skipped — no active recipient resolved for the configured audience.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const message = buildJobStrandedMessage(verdict);
    const idempotencyBase = `scheduled-job-stranded:${cairoDayKey()}:${problemSlugs.join(",")}`;
    const title =
      verdict.stranded.length > 0
        ? `Scheduled job stranded — ${verdict.stranded.map((problem) => problem.slug).join(", ")}`
        : `Scheduled job failing — ${verdict.failing.map((problem) => problem.slug).join(", ")}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/system-audit",
          actorId: ACTOR,
          // No email — see file header. In-app + Telegram + push only.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            problemSlugs,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the alert.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open the System Audit", ctaUrl: "/admin/system-audit" },
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: "observability.scheduled_job_stranded",
      entityType: "notification",
      newValues: { delivered, problemSlugs, warnings },
      summary: `Stranded-job alert delivered to ${delivered} recipient(s) for ${problemSlugs.join(", ")}.`,
    });

    return { delivered, skipped: false };
  } catch (error) {
    // Swallow: an alert about a broken job must never depend on itself to be delivered.
    logError("Stranded-job alert failed to dispatch", {
      error,
      labels: { event: "scheduled_job_stranded_alert_failed" },
    });
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
