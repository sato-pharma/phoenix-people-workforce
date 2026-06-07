import {
  cleanupOldNotificationData,
  processNotificationOutbox,
  reapStaleProcessingOutboxRows,
} from "@/lib/notifications/email";
import { processTelegramDeliveryRetries } from "@/lib/notifications/system";
import { processDueProbationReminderEvents } from "@/lib/probation/service";

export async function runScheduledNotificationProcessing(limit = 10) {
  const reaped = await reapStaleProcessingOutboxRows();
  const probationReminders = await processDueProbationReminderEvents(limit);
  const outbox = await processNotificationOutbox(limit);
  const telegram = await processTelegramDeliveryRetries(limit);
  const retention = await cleanupOldNotificationData();
  return { outbox, probationReminders, reaped, retention, telegram };
}
