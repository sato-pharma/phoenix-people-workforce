import { writeAuditLog } from "@/lib/admin/audit";
import { isProductionRuntime } from "@/config/system-settings";
import { shouldPersistErrorEvents } from "@/lib/error-monitor/derived-status";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import type { AiCallRecord } from "@/lib/observability/ai-metrics";
import { logError } from "@/lib/observability/log";

/**
 * Tells a human, in-app + Telegram, the moment the AI provider says the account is OUT OF CREDIT.
 *
 * Why: on 2026-09-18 at 09:55 OpenAI refused the Sales normalizer with `insufficient_quota`. The
 * failure reached app_error_events and nothing else — found by the next morning's error check. The
 * account has no auto-recharge (owner, 2026-09-18), so every AI feature stops when the balance
 * runs out, and no retry or wait fixes it: only a top-up does.
 *
 * Same shape as drain-health-alert.ts: the `weekly_system_health_digest` audience (retargetable
 * from /admin/notification-recipients), module "system", no email.
 *
 * Once per Cairo day: an in-process guard stops a burst of failing calls from each resolving
 * recipients, and the per-day idempotency key stops a second process sending it again.
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "ai_quota_exhausted";
const ACTOR = "ai-quota-alert";

let lastAlertedDay = "";

function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/** Pure message builder — no IO, so it is unit-testable without a database. */
export function buildAiQuotaExhaustedMessage(): string {
  return [
    "💳 OpenAI says the AI account is out of credit.",
    "",
    "Every AI feature is failing until it is topped up: CV extraction, the Sales normalizer's AI suggest,",
    "CRM campaign notes, the coach, expense notes and email assist. Waiting will not fix it — the account",
    "has no auto-recharge. Add credit on the OpenAI billing page and the features resume on their own.",
  ].join("\n");
}

/** Whether this process may page anyone: the real production app only — never staging, a laptop or the suite. */
export function aiQuotaAlertEnabled(): boolean {
  if (process.env.PHOENIX_TEST_SUITE === "1") return false;
  return shouldPersistErrorEvents() && isProductionRuntime();
}

/** Best-effort — never throws. */
export async function notifyAiQuotaExhausted(record: AiCallRecord): Promise<void> {
  try {
    if (!aiQuotaAlertEnabled()) return;
    const day = cairoDayKey();
    if (lastAlertedDay === day) return;
    lastAlertedDay = day;

    const { recipients, warnings } = await resolveNotificationPersonRecipients(AUDIENCE_KEY, "AI out-of-credit alert recipients");
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "ai.quota_exhausted",
        entityType: "notification",
        newValues: { failClosed: true, warnings },
        summary: "AI out-of-credit alert skipped — no active recipient resolved for the configured audience.",
      });
      return;
    }

    const message = buildAiQuotaExhaustedMessage();
    await Promise.all(
      recipients.map((recipient) =>
        createSystemNotification({
          actionUrl: "/admin/error-monitor",
          actorId: ACTOR,
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            idempotencyKey: `ai-quota-exhausted:${day}:${recipient.hrId}`,
            model: record.model,
            purpose: record.purpose,
          },
          // "system" is the module enabled for Telegram; an unknown module fails closed (see drain-health-alert.ts).
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open error monitor", ctaUrl: "/admin/error-monitor" },
          title: "OpenAI account is out of credit",
        }),
      ),
    );

    await writeAuditLog({
      actorLoginId: ACTOR,
      entityId: "ai.quota_exhausted",
      entityType: "notification",
      newValues: { delivered: recipients.length, purpose: record.purpose, warnings },
      summary: `AI out-of-credit alert delivered to ${recipients.length} recipient(s).`,
    });
  } catch (error) {
    logError("AI out-of-credit alert failed to dispatch", { error, labels: { event: "ai_quota_alert_failed" } });
  }
}
