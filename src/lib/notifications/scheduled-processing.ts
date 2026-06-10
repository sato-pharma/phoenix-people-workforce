import { runAttendanceIngestionAlert } from "@/lib/attendance/ingestion-health";
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
  const outbox = await processNotificationOutbox(limit);
  const deferred = await processDeferredDeliveryRetries(limit);
  const telegram = await processTelegramDeliveryRetries(limit);
  const retention = await cleanupOldNotificationData();
  return { attendanceAgent, deferred, outbox, probationReminders, reaped, retention, telegram };
}
