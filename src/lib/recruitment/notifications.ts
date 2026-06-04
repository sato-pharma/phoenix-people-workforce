// Recruitment / ATS — scheduled work. Composed into the single daily cron
// (app/api/notifications/daily) — do NOT add a new Vercel cron (Hobby limit = 2).
//
// Phase 1: reflect candidate offer decisions onto linked applications.
// Phase 2: remind interviewers of interviews scheduled for the next day.

import { enqueueInAppNotification } from "@/lib/notifications/in-app";
import { reconcileOfferStatuses } from "@/lib/recruitment/applications";
import { listInterviewsDueForReminder } from "@/lib/recruitment/interviews";

export type RecruitmentDailyResult =
  | { ok: true; reconciledOffers: number; interviewReminders: number }
  | { ok: false; reconciledOffers: 0; interviewReminders: 0; error: string };

async function sendInterviewReminders(): Promise<number> {
  const now = new Date();
  // Tomorrow's UTC window [start, end).
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 2, 0, 0, 0));
  const day = start.toISOString().slice(0, 10);

  const due = await listInterviewsDueForReminder(start.toISOString(), end.toISOString());
  let sent = 0;
  for (const interview of due) {
    if (!interview.interviewerHrId) continue;
    const result = await enqueueInAppNotification({
      category: "recruitment",
      dedupeKey: `recruitment_interview_reminder:${interview.id}:${day}`,
      href: "/recruitment",
      message: `You have a ${interview.interviewType.replace(/_/g, " ")} interview scheduled tomorrow.`,
      recipientHrId: interview.interviewerHrId,
      title: "Interview reminder",
    });
    if (!result.skipped) sent += 1;
  }
  return sent;
}

export async function runRecruitmentDailyNotifications(): Promise<RecruitmentDailyResult> {
  try {
    const reconciledOffers = await reconcileOfferStatuses();
    const interviewReminders = await sendInterviewReminders();
    return { ok: true, reconciledOffers, interviewReminders };
  } catch (error) {
    return {
      ok: false,
      reconciledOffers: 0,
      interviewReminders: 0,
      error: error instanceof Error ? error.message : "Recruitment daily processing failed.",
    };
  }
}
