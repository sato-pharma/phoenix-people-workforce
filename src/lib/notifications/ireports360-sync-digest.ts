import { writeAuditLog } from "@/lib/admin/audit";
import { createSystemNotification } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";

// Notifies Super Admins over Telegram/in-app every time a CRM (iReports360) pull finishes —
// success or failure — so someone always knows the visits mirror is fresh without having to
// check ireports360_visits_sync_runs manually. Mirrors runWeeklySystemHealthDigest's recipient
// + delivery pattern: module: "telegram" deliberately bypasses the editable-template path
// (see telegram-templates.ts) because this is a code-composed ops digest, not a per-employee
// workflow notification.

const SYNC_NOTIFY_AUDIENCE_ROLES = ["Super Admin"] as const;

export type IReports360SyncJobName = "ireports360-visits-sync" | "ireports360-visits-reconcile";

const JOB_LABELS: Record<IReports360SyncJobName, string> = {
  "ireports360-visits-reconcile": "Weekly Wide Reconciliation",
  "ireports360-visits-sync": "Daily Visits Sync",
};

export type IReports360SyncNotifyInput =
  | {
      status: "success";
      jobName: IReports360SyncJobName;
      dateFrom: string;
      dateTo: string;
      runId: string;
      result: {
        checkinsFetched: number;
        checkinsUpserted: number;
        rowsDeleted: number;
        rowsFetched: number;
        rowsSkippedInvalidDate: number;
        rowsUpserted: number;
      };
    }
  | {
      status: "failed";
      jobName: IReports360SyncJobName;
      dateFrom: string;
      dateTo: string;
      errorMessage: string;
    };

type SyncNotifyRecipient = { hrId: string; userId: string | null };

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

async function resolveSyncNotifyRecipients(): Promise<{ recipients: SyncNotifyRecipient[]; warnings: string[] }> {
  const warnings: string[] = [];
  const recipients: SyncNotifyRecipient[] = [];
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("app_auth_users")
      .select("login_id,hr_id,is_active")
      .in("role", SYNC_NOTIFY_AUDIENCE_ROLES as unknown as string[])
      .eq("is_active", true);
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ hr_id?: string | null; login_id?: string | null }>) {
      const hrId = cleanText(row.hr_id).toUpperCase();
      if (!hrId) continue;
      recipients.push({ hrId, userId: cleanText(row.login_id) || null });
    }
  } catch (error) {
    warnings.push(
      `Sync-notify recipients unavailable: ${error instanceof Error ? error.message : "unknown error"}`.slice(0, 160),
    );
  }
  return { recipients, warnings };
}

export function buildIReports360SyncMessage(input: IReports360SyncNotifyInput): string {
  const label = JOB_LABELS[input.jobName];
  const lines: string[] = [];
  if (input.status === "success") {
    lines.push(`✅ iReports360 CRM Sync — ${label}`);
    lines.push(`Window: ${input.dateFrom} → ${input.dateTo}`);
    lines.push("");
    lines.push(`Visits fetched: ${input.result.rowsFetched}`);
    lines.push(`Visits upserted: ${input.result.rowsUpserted}`);
    if (input.result.rowsDeleted > 0) lines.push(`Visits removed (voided in CRM): ${input.result.rowsDeleted}`);
    if (input.result.rowsSkippedInvalidDate > 0) {
      lines.push(`Visits skipped (invalid date): ${input.result.rowsSkippedInvalidDate}`);
    }
    lines.push(`Check-ins fetched: ${input.result.checkinsFetched}`);
    lines.push(`Check-ins upserted: ${input.result.checkinsUpserted}`);
    lines.push("");
    lines.push("Details → /admin/visits-report");
  } else {
    lines.push(`❌ iReports360 CRM Sync FAILED — ${label}`);
    lines.push(`Window: ${input.dateFrom} → ${input.dateTo}`);
    lines.push("");
    lines.push(`Error: ${input.errorMessage}`.slice(0, 500));
    lines.push("");
    lines.push("Details → /admin/visits-report");
  }
  return lines.join("\n");
}

export type IReports360SyncNotifyResult = { delivered: number; reason?: string; skipped: boolean };

/**
 * Best-effort — never throws. Called by both the daily sync and weekly wide-reconciliation
 * crons after every run (success or failure), so Super Admins always know the CRM mirror is
 * fresh without checking ireports360_visits_sync_runs manually.
 */
export async function notifyIReports360SyncResult(input: IReports360SyncNotifyInput): Promise<IReports360SyncNotifyResult> {
  try {
    const { recipients, warnings } = await resolveSyncNotifyRecipients();
    const message = buildIReports360SyncMessage(input);
    // A unique key per delivery: the success path's runId is already unique per sync run; the
    // failure path has no runId in scope at the route level, so a timestamp stands in. Without
    // a unique key, eventKeyFor() would hash eventType+module+recipient+title (which repeat
    // identically across every cron firing) and every run after the first would silently dedupe
    // away as "already sent" instead of delivering.
    const idempotencyBase =
      input.status === "success"
        ? `ireports360-sync:${input.jobName}:${input.runId}`
        : `ireports360-sync:${input.jobName}:failed:${input.dateFrom}:${input.dateTo}:${Date.now()}`;

    if (recipients.length === 0) {
      await writeAuditLog({
        actorLoginId: "ireports360-sync-cron",
        entityId: `telegram.ireports360_sync_${input.jobName}`,
        entityType: "notification",
        newValues: { failClosed: true, status: input.status, warnings },
        summary: "iReports360 sync notification skipped — no Super Admin recipient resolved.",
      });
      return { delivered: 0, reason: "no recipients", skipped: true };
    }

    const priority = input.status === "failed" ? "high" : "normal";
    const title =
      input.status === "failed"
        ? `iReports360 CRM Sync Failed — ${JOB_LABELS[input.jobName]}`
        : `iReports360 CRM Sync Complete — ${JOB_LABELS[input.jobName]}`;

    let delivered = 0;
    await Promise.all(
      recipients.map(async (recipient) => {
        await createSystemNotification({
          actionUrl: "/admin/visits-report",
          actorId: "ireports360-sync-cron",
          channels: ["in_app", "telegram"],
          eventType: `ireports360_sync_${input.status}`,
          message,
          metadata: {
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
            idempotencyKey: `${idempotencyBase}:${recipient.hrId}`,
            jobName: input.jobName,
            status: input.status,
            ...(input.status === "success" ? { result: input.result } : { errorMessage: input.errorMessage }),
          },
          // "system" is the module actually enabled in notification_module_channel_policies for
          // Telegram ("Optional Telegram channel for system tests and announcements") — NOT the
          // literal string "telegram", which has no governance policy row (code default or DB)
          // and therefore fails closed via resolveTelegramGovernance's unknown-module fail-safe.
          // Confirmed live 2026-07-12: runWeeklySystemHealthDigest / runTelegramDailyHrDigest both
          // pass module: "telegram" too and hit the same fail-closed gate — their Telegram channel
          // has likely never actually delivered, only in-app (pre-existing bug, out of scope here).
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
      actorLoginId: "ireports360-sync-cron",
      entityId: `telegram.ireports360_sync_${input.jobName}`,
      entityType: "notification",
      newValues: { delivered, status: input.status, warnings },
      summary: `iReports360 ${input.status === "success" ? "sync" : "sync failure"} notification processed.`,
    });

    return { delivered, skipped: false };
  } catch (error) {
    // Never let a notification-delivery bug turn an otherwise-successful (or already-failed)
    // CRM sync into a second, unrelated failure — the caller always wraps this in .catch() too,
    // but this inner guard keeps the function's own contract ("never throws") honest.
    return { delivered: 0, reason: error instanceof Error ? error.message : "unknown error", skipped: true };
  }
}
