import { processNotificationOutbox } from "@/lib/notifications/email";
import { processDueProbationReminderEvents } from "@/lib/probation/service";

export async function runScheduledNotificationProcessing(limit = 10) {
  const probationReminders = await processDueProbationReminderEvents(limit);
  const outbox = await processNotificationOutbox(limit);
  return { outbox, probationReminders };
}
