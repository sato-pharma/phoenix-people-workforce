import { writeAuditLog } from "@/lib/admin/audit";
import {
  buildGithubWorkflowMessage,
  type GithubWorkflowVerdict,
} from "@/lib/observability/github-workflow-watch";
import { logError } from "@/lib/observability/log";
import { resolveNotificationPersonRecipients } from "@/lib/notifications/role-recipients";
import { createSystemNotification } from "@/lib/notifications/system";

/**
 * Tells a person, in-app + Telegram + push, that a check on GitHub is overdue or its token is dying.
 *
 * The same audience and the same no-email reasoning as job-heartbeat-alert.ts. An overdue check is not
 * a failed run of THIS job, so it travels here rather than through the sweep: the sweep carries only
 * the watch itself going blind.
 */

const AUDIENCE_KEY = "weekly_system_health_digest" as const;
const EVENT_TYPE = "github_workflow_overdue";
const ACTOR = "github-workflow-watch";

export type GithubWorkflowAlertResult = {
  delivered: number;
  reason?: string;
  skipped: boolean;
};

function cairoDayKey(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo" }).format(new Date());
}

/**
 * Best-effort, never throws. Keyed per Cairo day and per set of overdue workflows, so an hourly job
 * alerts once a day about a standing fault while a NEWLY overdue check still gets through.
 */
export async function notifyGithubWorkflows(verdict: GithubWorkflowVerdict): Promise<GithubWorkflowAlertResult> {
  try {
    if (verdict.overdue.length === 0 && verdict.tokenWarningDays === null) {
      return { delivered: 0, reason: "healthy", skipped: true };
    }
    const files = verdict.overdue.map((item) => item.file).sort();
    const { recipients, warnings } = await resolveNotificationPersonRecipients(AUDIENCE_KEY, "GitHub workflow watch recipients");
    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: ACTOR,
        entityId: "observability.github_workflow_overdue",
        entityType: "notification",
        newValues: { failClosed: true, files, warnings },
        summary: "GitHub workflow alert skipped: no active recipient resolved for the configured audience.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const title =
      verdict.overdue.length > 0
        ? `GitHub check overdue: ${verdict.overdue.map((item) => item.label).join(", ")}`
        : "The GitHub token Phoenix uses is close to expiring";
    const tokenPart = verdict.tokenWarningDays === null ? "" : `:token-${verdict.tokenWarningDays}`;
    const idempotencyBase = `github-workflow-overdue:${cairoDayKey()}:${files.join(",")}${tokenPart}`;
    const message = buildGithubWorkflowMessage(verdict);

    await Promise.all(
      recipients.map((recipient) =>
        createSystemNotification({
          actionUrl: "/admin/system-audit",
          actorId: ACTOR,
          // No email, see job-heartbeat-alert.ts.
          channels: ["in_app", "telegram", "push"],
          eventType: EVENT_TYPE,
          message,
          metadata: { files, idempotencyKey: `${idempotencyBase}:${recipient.hrId}` },
          // `system` is the module enabled for Telegram; an unknown module string fails closed.
          module: "system",
          priority: "high",
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          telegram: { ctaLabel: "Open the System Audit", ctaUrl: "/admin/system-audit" },
          title,
        }),
      ),
    );
    return { delivered: recipients.length, skipped: false };
  } catch (error) {
    logError("GitHub workflow alert failed to dispatch", {
      error,
      labels: { event: "github_workflow_overdue_alert_failed" },
    });
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
