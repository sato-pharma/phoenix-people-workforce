// Recruitment / ATS — scheduled work. Composed into the single daily cron
// (app/api/notifications/daily) — do NOT add a new Vercel cron (Hobby limit = 2).
//
// Remind interviewers of interviews scheduled for the next day.

import { currentCairoDateParts } from "@/lib/i18n/format";
import { createSystemNotification } from "@/lib/notifications/system";
import { interviewTypeLabel } from "@/lib/recruitment/interview-notifications";
import { listInterviewsDueForReminder } from "@/lib/recruitment/interviews";

export type RecruitmentDailyResult =
  | { ok: true; interviewReminders: number }
  | { ok: false; interviewReminders: 0; error: string };

async function sendInterviewReminders(): Promise<number> {
  const { year, month, day: cairoDay } = currentCairoDateParts();
  // Tomorrow's window [start, end) — Cairo's tomorrow, expressed as UTC instants.
  const start = new Date(Date.UTC(year, month - 1, cairoDay + 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month - 1, cairoDay + 2, 0, 0, 0));
  const day = start.toISOString().slice(0, 10);

  const due = await listInterviewsDueForReminder(start.toISOString(), end.toISOString());
  let sent = 0;
  for (const interview of due) {
    if (!interview.interviewerHrId) continue;
    const at = interview.scheduledAt
      ? new Date(interview.scheduledAt).toLocaleTimeString("en-GB", {
          timeZone: "Africa/Cairo",
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    const result = await createSystemNotification({
      actionUrl: "/recruitment",
      category: "recruitment",
      eventType: "interview_reminder",
      message: `Reminder: you have a ${interviewTypeLabel(interview.interviewType).toLowerCase()} interview tomorrow${at ? ` at ${at}` : ""}.`,
      metadata: { idempotencyKey: `recruitment_interview_reminder:${interview.id}:${day}`, interviewId: interview.id },
      module: "recruitment",
      priority: "normal",
      recipientHrId: interview.interviewerHrId,
      title: "Interview reminder",
    });
    if (result.deliveries.some((delivery) => delivery.status === "sent")) sent += 1;
  }
  return sent;
}

export async function runRecruitmentDailyNotifications(): Promise<RecruitmentDailyResult> {
  try {
    const interviewReminders = await sendInterviewReminders();
    return { ok: true, interviewReminders };
  } catch (error) {
    return {
      ok: false,
      interviewReminders: 0,
      error: error instanceof Error ? error.message : "Recruitment daily processing failed.",
    };
  }
}
