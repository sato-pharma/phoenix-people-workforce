
import { runAttendanceIngestionAlert } from "@/lib/attendance/ingestion-health";
import { runAttendanceDigestScheduledProcessing } from "@/lib/attendance/digest-scheduler";
import { getInactiveUsers, purgeOldActivityEvents } from "@/lib/activity/service";
import { supersedeExitedEmployeeDeductionCandidates } from "@/lib/deductions-governance/service";
import {
  cleanupOldNotificationData,
  processNotificationOutbox,
  reapStaleProcessingOutboxRows,
} from "@/lib/notifications/email";
import { processDeferredDeliveryRetries, processTelegramDeliveryRetries } from "@/lib/notifications/system";
import { processDueProbationReminderEvents } from "@/lib/probation/service";
import { processFeedbackSlaReminders } from "@/lib/probation/intelligence/feedback-sla-reminders";
import { processProbationMilestoneEmails } from "@/lib/probation/intelligence/probation-emails";
import { cleanupStalePendingSosBatches } from "@/lib/sales/source-of-sales-batch-supersede";
import { reapStaleIReports360SyncRuns } from "@/lib/visits-report/service";

export async function runScheduledNotificationProcessing(limit = 10) {
  // Never throws; internally catches and returns 0 on failure (see the function's own try/catch).
  const reaped = await reapStaleProcessingOutboxRows();
  // Never throws; internally catches and returns 0 on failure (see the function's own try/catch).
  // Rides this cron because it's the most frequent one (every 30 min) — see the 2026-07-05
  // ireports360-visits-reconcile incident this reaper exists to catch promptly next time.
  const reapedVisitsSyncRuns = await reapStaleIReports360SyncRuns();
  const probationReminders = await processDueProbationReminderEvents(limit).catch((e: unknown) => {
    console.error(e, { tags: { cron: "notification-process-probation-reminders" } });
    return { attempted: 0, failed: 1, processedIds: [] as string[], sent: 0, error: String(e) };
  });
  // State-based DV feedback SLA reminders/escalations (deduped by (DV-Day, state) idempotency key).
  const probationFeedbackSla = await processFeedbackSlaReminders().catch((e: unknown) => {
    console.error(e, { tags: { cron: "notification-process-probation-feedback-sla" } });
    return { scanned: 0, due: 0, escalated: 0, overdue: 0, notificationsEmitted: 0, error: String(e) };
  });
  // Day 30/60/75 milestone emails (deduped per case+milestone idempotency key — safe to run often).
  const probationMilestones = await processProbationMilestoneEmails().catch((e: unknown) => {
    console.error(e, { tags: { cron: "notification-process-probation-milestones" } });
    return { scanned: 0, sent: 0, error: String(e) };
  });
  // Never throws; per-day idempotency key prevents duplicate alerts across runs.
  const attendanceAgent = await runAttendanceIngestionAlert();
  // Never throws; draft/sent status guards + unique constraints make every
  // step idempotent, so a missed day or a re-run always safely catches up.
  const attendanceDigest = await runAttendanceDigestScheduledProcessing();
  // Never throws; idempotent cleanup of pending deduction warnings for exited employees.
  const exitedDeductions = await supersedeExitedEmployeeDeductionCandidates();
  // Never throws; clears Source of Sales batches that died mid-pipeline before reaching 'validated'.
  const staleSosBatches = await cleanupStalePendingSosBatches();
  const outbox = await processNotificationOutbox(limit).catch((e: unknown) => {
    console.error(e, { tags: { cron: "notification-process-outbox" } });
    return { attempted: 0, failed: 1, processedIds: [] as string[], sent: 0, skipped: 0, error: String(e) };
  });
  const deferred = await processDeferredDeliveryRetries(limit).catch((e: unknown) => {
    console.error(e, { tags: { cron: "notification-process-deferred" } });
    return { attempted: 0, deferred: 0, sent: 0, skipped: 0, error: String(e) };
  });
  const telegram = await processTelegramDeliveryRetries(limit).catch((e: unknown) => {
    console.error(e, { tags: { cron: "notification-process-telegram" } });
    return { attempted: 0, failed: 1, sent: 0, error: String(e) };
  });
  // Never throws; every step inside has its own internal try/catch (see cleanupOldNotificationData).
  const retention = await cleanupOldNotificationData();
  // Activity Control Center retention: drop page-view events older than 90 days. Never throws;
  // has its own internal try/catch (see purgeOldActivityEvents).
  const activityRetention = await purgeOldActivityEvents(90);
  // Compute users inactive for 7+ days — logged for now; full alert notifications are a follow-up.
  const inactiveUsers = await getInactiveUsers(7).catch(() => []);
  if (inactiveUsers.length) {
    console.info(`[activity] inactivity digest: ${inactiveUsers.length} user(s) inactive 7+ days — ${inactiveUsers.slice(0, 5).map((u) => u.name).join(", ")}${inactiveUsers.length > 5 ? "…" : ""}`);
  }
  return { activityRetention, attendanceAgent, attendanceDigest, deferred, exitedDeductions, inactiveUsers: inactiveUsers.length, outbox, probationFeedbackSla, probationMilestones, probationReminders, reaped, reapedVisitsSyncRuns, retention, staleSosBatches, telegram };
}
