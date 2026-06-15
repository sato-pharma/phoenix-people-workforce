import { runAttendanceIngestionAlert } from "@/lib/attendance/ingestion-health";
import { getInactiveUsers, purgeOldActivityEvents } from "@/lib/activity/service";
import { supersedeExitedEmployeeDeductionCandidates } from "@/lib/deductions-governance/service";
import {
  cleanupOldNotificationData,
  processNotificationOutbox,
  reapStaleProcessingOutboxRows,
} from "@/lib/notifications/email";
import { processDeferredDeliveryRetries, processTelegramDeliveryRetries } from "@/lib/notifications/system";
import { processDueProbationReminderEvents } from "@/lib/probation/service";

export async function runScheduledNotificationProcessing(limit = 10) {
  const reaped = await reapStaleProcessingOutboxRows();
  const probationReminders = await processDueProbationReminderEvents(limit);
  // Never throws; per-day idempotency key prevents duplicate alerts across runs.
  const attendanceAgent = await runAttendanceIngestionAlert();
  // Never throws; idempotent cleanup of pending deduction warnings for exited employees.
  const exitedDeductions = await supersedeExitedEmployeeDeductionCandidates();
  const outbox = await processNotificationOutbox(limit);
  const deferred = await processDeferredDeliveryRetries(limit);
  const telegram = await processTelegramDeliveryRetries(limit);
  const retention = await cleanupOldNotificationData();
  // Activity Control Center retention: drop page-view events older than 90 days.
  const activityRetention = await purgeOldActivityEvents(90);
  // Compute users inactive for 7+ days — logged for now; full alert notifications are a follow-up.
  const inactiveUsers = await getInactiveUsers(7).catch(() => []);
  if (inactiveUsers.length) {
    console.info(`[activity] inactivity digest: ${inactiveUsers.length} user(s) inactive 7+ days — ${inactiveUsers.slice(0, 5).map((u) => u.name).join(", ")}${inactiveUsers.length > 5 ? "…" : ""}`);
  }
  return { activityRetention, attendanceAgent, deferred, exitedDeductions, inactiveUsers: inactiveUsers.length, outbox, probationReminders, reaped, retention, telegram };
}
