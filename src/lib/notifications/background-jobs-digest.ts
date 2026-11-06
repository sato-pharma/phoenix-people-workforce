import { writeAuditLog } from "@/lib/admin/audit";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { BackgroundJobRunOutcome } from "@/lib/background-jobs/worker";

// Notifies Super Admins over Telegram/in-app every time the weekly background-jobs worker
// fires — success or failure — since the worker itself now only runs once a week (see
// app/api/cron/background-jobs/route.ts) instead of draining continuously. It took its recipient +
// delivery pattern from the iReports360 sync digest, retired with that vendor on 6 November 2026.

const NOTIFY_AUDIENCE_ROLES = ["Super Admin"] as const;

export type BackgroundJobsRunNotifyInput =
  | { status: "success"; processed: number; results: BackgroundJobRunOutcome[] }
  | { status: "failed"; errorMessage: string };

type NotifyRecipient = { hrId: string; userId: string | null };

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function todayDisplay() {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Africa/Cairo",
  }).format(new Date());
}

async function resolveNotifyRecipients(): Promise<{ recipients: NotifyRecipient[]; warnings: string[] }> {
  const warnings: string[] = [];
  const recipients: NotifyRecipient[] = [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,is_active")
      .in("role", NOTIFY_AUDIENCE_ROLES as unknown as string[])
      .eq("is_active", true);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>) {
      const hrId = cleanText(row.hr_id).toUpperCase();
      if (!hrId) continue;
      recipients.push({ hrId, userId: cleanText(row.login_id) || null });
    }
  } catch (error) {
    warnings.push(
      `Background-jobs-notify recipients unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
    );
  }
  return { recipients, warnings };
}

export function buildBackgroundJobsRunMessage(input: BackgroundJobsRunNotifyInput): string {
  const date = todayDisplay();
  const lines: string[] = [];
  if (input.status === "success") {
    const completed = input.results.filter((r) => r.status === "completed");
    const failed = input.results.filter((r) => r.status === "failed");
    lines.push(`✅ Weekly Background Jobs Run — ${date}`);
    lines.push("");
    lines.push(`Processed: ${input.processed}`);
    lines.push(`Completed: ${completed.length}`);
    lines.push(`Failed: ${failed.length}`);
    if (failed.length > 0) {
      lines.push("");
      lines.push("Failures:");
      for (const job of failed.slice(0, 5)) {
        lines.push(`- ${job.jobType} (${job.id.slice(0, 8)}): ${(job.error ?? "unknown error").slice(0, 200)}`);
      }
      if (failed.length > 5) lines.push(`… and ${failed.length - 5} more.`);
    }
    lines.push("");
    lines.push("Details → /admin/data-backup");
  } else {
    lines.push(`❌ Weekly Background Jobs Run FAILED — ${date}`);
    lines.push("");
    lines.push(`Error: ${input.errorMessage}`.slice(0, 500));
    lines.push("");
    lines.push("Details → /admin/data-backup");
  }
  return lines.join("\n");
}

export type BackgroundJobsRunNotifyResult = { delivered: number; reason?: string; skipped: boolean };

/**
 * Best-effort — never throws. Called by the weekly background-jobs cron after every run
 * (success or failure) so Super Admins know the export queue was drained without having to
 * check /admin/data-backup manually.
 */
export async function notifyBackgroundJobsRun(input: BackgroundJobsRunNotifyInput): Promise<BackgroundJobsRunNotifyResult> {
  try {
    const { recipients, warnings } = await resolveNotifyRecipients();
    const message = buildBackgroundJobsRunMessage(input);
    const idempotencyBase =
      input.status === "success"
        ? `background-jobs-run:${new Date().toISOString().slice(0, 10)}`
        : `background-jobs-run:failed:${new Date().toISOString().slice(0, 10)}`;

    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: "background-jobs-cron",
        entityId: "telegram.background_jobs_run",
        entityType: "notification",
        newValues: { failClosed: true, status: input.status, warnings },
        summary: "Background-jobs weekly-run notification skipped — no Super Admin recipient resolved.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const priority = input.status === "failed" ? "high" : "normal";
    const title = input.status === "failed" ? "Weekly Background Jobs Run Failed" : "Weekly Background Jobs Run Complete";

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/data-backup",
          actorId: "background-jobs-cron",
          // A FAILURE takes every channel. A routine success does not reach Telegram (owner rule
          // 2026-10-15) — it stays on record in-app. The real enforcement is the post-filter in
          // basePolicyChannels, which the policy fallback cannot bypass; this line is here so the
          // rule is visible where the digest is composed. See ops-success-digest-channel-guard.ts.
          channels: input.status === "failed" ? ["in_app", "telegram", "push"] : ["in_app", "push"],
          eventType: `background_jobs_run_${input.status}`,
          message,
          metadata: {
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            status: input.status,
            ...(input.status === "success"
              ? { processed: input.processed, results: input.results }
              : { errorMessage: input.errorMessage }),
          },
          // module: "system" is the module actually enabled in notification_module_channel_policies
          // for Telegram, and held-notification-alert.ts uses it for the same reason. The literal string
          // "telegram" has no governance policy row and fails closed via resolveTelegramGovernance's
          // unknown-module fail-safe.
          module: "system",
          priority,
          recipientHrId: recipient.hrId,
          recipientUserId: recipient.userId,
          title,
        });
        delivered += 1;
      }),
    );

    await writeAuditLog({
      actorLoginId: "background-jobs-cron",
      entityId: "telegram.background_jobs_run",
      entityType: "notification",
      newValues: { delivered, status: input.status, warnings },
      summary: `Weekly background-jobs run notification processed.`,
    });

    return { delivered, skipped: false };
  } catch (error) {
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
