// Recruitment / ATS — scheduled work. Composed into the single daily cron
// (app/api/notifications/daily) — do NOT add a new Vercel cron (Hobby limit = 2).
//
// Three jobs run here:
//   - remind interviewers of interviews scheduled for the next day;
//   - chase CVs that were sent to a hiring manager and never answered (`stale-send-check.ts`);
//   - report CVs nobody has looked at yet (`triage-backlog-check.ts`).

import { currentCairoDateParts } from "@/lib/i18n/format";
import { createSystemNotification } from "@/lib/notifications/system";
import { interviewTypeLabel } from "@/lib/recruitment/interview-notifications";
import { listInterviewsDueForReminder } from "@/lib/recruitment/interviews";
import { runStaleSendCheck, type StaleSendRunResult } from "@/lib/recruitment/stale-send-check";
import { runTriageBacklogCheck, type TriageBacklogRunResult } from "@/lib/recruitment/triage-backlog-check";

export type RecruitmentDailyResult =
  | { ok: true; interviewReminders: number; staleSends: StaleSendRunResult; triageBacklog: TriageBacklogRunResult }
  | {
      ok: false;
      interviewReminders: 0;
      staleSends: StaleSendRunResult | null;
      triageBacklog: TriageBacklogRunResult | null;
      error: string;
    };

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
  // The stale-send check runs FIRST and independently of the reminders, because it swallows its own
  // errors and returns a verdict. If it ran second and the reminder loop threw, the check would be
  // skipped entirely on that day’s run — and the whole point of it is to notice silence.
  const staleSends = await runStaleSendCheck();
  // Same reasoning, one stage earlier: it swallows its own errors and returns a verdict, so running
  // it before the throwing reminder loop means a bad reminder cannot suppress the day’s backlog
  // report. The two checks are independent and neither reads the other’s result.
  const triageBacklog = await runTriageBacklogCheck();
  try {
    const interviewReminders = await sendInterviewReminders();
    return { ok: true, interviewReminders, staleSends, triageBacklog };
  } catch (error) {
    return {
      ok: false,
      interviewReminders: 0,
      staleSends,
      triageBacklog,
      error: error instanceof Error ? error.message : "Recruitment daily processing failed.",
    };
  }
}
