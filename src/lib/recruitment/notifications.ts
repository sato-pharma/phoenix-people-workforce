// Recruitment / ATS — scheduled work. Runs every morning as its own job, `recruitment-notifications`
// (06:52 Cairo, /api/cron/daily/recruitment-notifications; src/lib/scheduled-jobs/daily-jobs.ts).
//
// Five jobs run here:
//   - remind interviewers of interviews scheduled for the next day;
//   - take back the CVs that have sat 45 days with their managers (`manager-hold-return.ts`) —
//     FIRST, so the next job never chases a manager about a CV he no longer holds;
//   - chase CVs that were sent to a hiring manager and never answered (`stale-send-check.ts`);
//   - report CVs nobody has looked at yet (`triage-backlog-check.ts`);
//   - warn before the owner's live CV-lifecycle sheet loses its feed token
//     (`cv-lifecycle-link-expiry-alert.ts`).
//
// The fourth job is composed HERE rather than as a fifth entry in the daily route's Promise.all,
// deliberately. That list destructures 22 results positionally and has silently gone off-by-one
// TWICE — 2026-07-18 and again 2026-08-29 — each time by someone adding a job. This module is
// already in the list, so adding a check inside it changes no position at all.

import { currentCairoDateParts } from "@/lib/i18n/format";
import { createSystemNotification } from "@/lib/notifications/system";
import { interviewTypeLabel } from "@/lib/recruitment/interview-notifications";
import { listInterviewsDueForReminder } from "@/lib/recruitment/interviews";
import {
  runCvLifecycleLinkExpiryCheck,
  type CvLifecycleLinkExpiryRunResult,
} from "@/lib/recruitment/cv-lifecycle-link-expiry-alert";
import { runManagerHoldReturn, type ManagerHoldReturnResult } from "@/lib/recruitment/manager-hold-return";
import { runStaleSendCheck, type StaleSendRunResult } from "@/lib/recruitment/stale-send-check";
import { runTriageBacklogCheck, type TriageBacklogRunResult } from "@/lib/recruitment/triage-backlog-check";

export type RecruitmentDailyResult =
  | {
      ok: true;
      cvLifecycleLinkExpiry: CvLifecycleLinkExpiryRunResult;
      interviewReminders: number;
      managerHoldReturn: ManagerHoldReturnResult;
      staleSends: StaleSendRunResult;
      triageBacklog: TriageBacklogRunResult;
    }
  | {
      ok: false;
      cvLifecycleLinkExpiry: CvLifecycleLinkExpiryRunResult | null;
      interviewReminders: 0;
      managerHoldReturn: ManagerHoldReturnResult | null;
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
  // The 45-day return runs before everything else, and the order is the point: it moves a CV out of
  // `sent_to_manager`, and the stale-send check below reads exactly that status. Run second, the
  // check would nudge a manager about a CV this step had just taken back and escalate it to the desk
  // as "stuck". Like its neighbours it swallows its own errors and returns a verdict.
  const managerHoldReturn = await runManagerHoldReturn();
  // The stale-send check runs next and independently of the reminders, because it swallows its own
  // errors and returns a verdict. If it ran second and the reminder loop threw, the check would be
  // skipped entirely on that day’s run — and the whole point of it is to notice silence.
  const staleSends = await runStaleSendCheck();
  // Same reasoning, one stage earlier: it swallows its own errors and returns a verdict, so running
  // it before the throwing reminder loop means a bad reminder cannot suppress the day’s backlog
  // report. The two checks are independent and neither reads the other’s result.
  const triageBacklog = await runTriageBacklogCheck();
  // Third for the same reason as the two above, and it matters most here: this is the check that
  // exists to break a SILENCE. A feed that has gone dark announces itself nowhere else, so the one
  // job that would notice must not be the one a throwing reminder loop skips.
  const cvLifecycleLinkExpiry = await runCvLifecycleLinkExpiryCheck();
  try {
    const interviewReminders = await sendInterviewReminders();
    return { ok: true, cvLifecycleLinkExpiry, interviewReminders, managerHoldReturn, staleSends, triageBacklog };
  } catch (error) {
    return {
      ok: false,
      cvLifecycleLinkExpiry,
      interviewReminders: 0,
      managerHoldReturn,
      staleSends,
      triageBacklog,
      error: error instanceof Error ? error.message : "Recruitment daily processing failed.",
    };
  }
}
