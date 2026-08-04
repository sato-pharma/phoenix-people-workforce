import { writeAuditLog } from "@/lib/admin/audit";
import type { PhoenixRole } from "@/lib/auth/permissions";
import { logError } from "@/lib/observability/log";
import {
  resolveNotificationRoleEnabled,
  resolveNotificationRoleRecipients,
} from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";
import { buildReconciliationAlertMessage } from "@/lib/reconciliation/runner";
import type { ReconciliationReport } from "@/lib/reconciliation/types";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * Tells a human, once a day, that a number a user reads disagrees with the number underneath it.
 *
 * Audience comes from the admin-editable notification-recipients registry rather than a hardcoded
 * role array — that registry exists precisely because a dozen cron notifications had their
 * audiences buried in code where nobody could change them. `weekly_system_health_digest` is the
 * existing "technical/system health" audience; reusing it means the owner can retarget or silence
 * this alert from /admin/notification-recipients today, with no new key and no migration, and the
 * master-off switch that key already carries works here too.
 */
const RECONCILIATION_AUDIENCE_KEY = "weekly_system_health_digest" as const;

const EVENT_TYPE = "reconciliation_breach_detected";

type NotifyRecipient = { hrId: string; userId: string | null };

export type ReconciliationAlertResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

async function resolveRecipients(roles: readonly PhoenixRole[]): Promise<{ recipients: NotifyRecipient[]; warnings: string[] }> {
  const warnings: string[] = [];
  const recipients: NotifyRecipient[] = [];
  if (roles.length === 0) return { recipients, warnings };
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,is_active")
      .in("role", roles as unknown as string[])
      .eq("is_active", true);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>) {
      const hrId = cleanText(row.hr_id).toUpperCase();
      if (!hrId) continue;
      recipients.push({ hrId, userId: cleanText(row.login_id) || null });
    }
  } catch (error) {
    warnings.push(
      `Reconciliation-alert recipients unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
    );
  }
  return { recipients, warnings };
}

/** Cairo calendar day — the unit the idempotency key is bucketed on, so "once a day" means the owner's day. */
function cairoDayKey(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Africa/Cairo",
  }).format(new Date());
  return parts;
}

/**
 * Best-effort — never throws. A failed alert must not turn a reconciliation breach into a second,
 * self-inflicted outage; the report itself is returned to the caller either way.
 *
 * The idempotency key is bucketed per Cairo day AND per set of breached check ids, so a breach
 * that persists reminds once every day rather than once every run, and a NEW breach appearing
 * later the same day still gets through instead of being swallowed by the morning's key.
 */
export async function notifyReconciliationBreach(report: ReconciliationReport): Promise<ReconciliationAlertResult> {
  try {
    if (!report.alerting) return { delivered: 0, reason: "no breach", skipped: true };

    if (!(await resolveNotificationRoleEnabled(RECONCILIATION_AUDIENCE_KEY))) {
      return { delivered: 0, reason: "audience disabled by admin", skipped: true };
    }

    const roles = await resolveNotificationRoleRecipients(RECONCILIATION_AUDIENCE_KEY);
    const { recipients, warnings } = await resolveRecipients(roles);

    const breachedIds = report.results
      .filter((result) => result.status === "breached" || result.status === "errored")
      .map((result) => result.id)
      .sort();

    if (recipients.length === 0) {
      // Fail LOUDLY into the audit trail rather than silently: a breach nobody was told about is
      // the exact failure mode this whole harness was built to end.
      await writeAuditLog({
        actorLoginId: "reconciliation-cron",
        entityId: "reconciliation.breach",
        entityType: "notification",
        newValues: { breachedIds, failClosed: true, roles, warnings },
        summary: "Reconciliation breach alert skipped — no active recipient resolved for the configured roles.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const message = buildReconciliationAlertMessage(report);
    const idempotencyBase = `reconciliation-breach:${cairoDayKey()}:${breachedIds.join(",")}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/system-issues",
          actorId: "reconciliation-cron",
          // No email: this alert can fire because the email pipeline itself is the thing
          // disagreeing, and an alert that depends on the broken channel is not an alert.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: {
            breachedIds,
            counts: report.counts,
            generatedAt: report.generatedAt,
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
          },
          // module: "system" is the module actually enabled for Telegram in
          // notification_module_channel_policies — an unknown module string fails closed in
          // resolveTelegramGovernance, which would silently drop the alert.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open system issues", ctaUrl: "/admin/system-issues" },
          title: `Reconciliation breach — ${report.counts.breached} check(s) disagree`,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: "reconciliation-cron",
      entityId: "reconciliation.breach",
      entityType: "notification",
      newValues: { breachedIds, counts: report.counts, delivered, warnings },
      summary: `Reconciliation breach alert delivered to ${delivered} recipient(s).`,
    });

    return { delivered, skipped: false };
  } catch (error) {
    logError("Reconciliation breach alert failed to dispatch", {
      error,
      labels: { event: "reconciliation_alert_failed" },
    });
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
