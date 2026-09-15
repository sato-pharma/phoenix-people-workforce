// Telling an employee that a week of their attendance has been released for an answer.
//
// Owner rule 2026-09-15: in-app and Telegram, never email (hard-blocked in
// attendance-digest-channel-guard.ts). Sent ONLY when the Super Admin releases the week — the
// daily job that builds a week sends nothing.
//
// The message names the week, how many days need an answer and the deadline. It carries no
// amount: Telegram is a lock-screen channel, and the amount is one tap away on the page.

import { buildWeekReleasedMessage, releaseNoticeReached } from "@/lib/attendance/digest-rules.ts";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";

export { buildWeekReleasedMessage };

export const WEEKLY_ATTENDANCE_PORTAL_URL = "/employee-portals/attendance/digests";

/**
 * Never throws: a notice that cannot be delivered must not undo a release already written.
 * Returns true only when in-app or Telegram actually took the notice — see releaseNoticeReached.
 */
export async function notifyAttendanceWeekReleased(input: {
  digestId: number;
  employeeHrId: string;
  weekStart: string;
  weekEnd: string;
  dayCount: number;
  answerDueOn: string;
}): Promise<boolean> {
  try {
    const { title, message } = buildWeekReleasedMessage(input);
    const result = await createSystemNotificationForRecipients(
      {
        category: "attendance_digest",
        module: "attendance_digest",
        eventType: "week_released",
        priority: "high",
        actionUrl: WEEKLY_ATTENDANCE_PORTAL_URL,
        channels: ["in_app", "telegram"],
        // The employee the week describes is the only recipient; naming them as the subject too
        // keeps this on the "sensitive content to its own subject" path if the module is ever
        // listed as sensitive.
        subjectHrId: input.employeeHrId,
        title,
        message,
        metadata: {
          employeeHrId: input.employeeHrId,
          attendanceDigestId: input.digestId,
          // One notice per digest, ever: a second click on Release, or a retry after a timeout,
          // cannot tell the same employee twice.
          idempotencyKey: `attendance_digest:${input.digestId}:released`,
        },
      },
      [input.employeeHrId],
    );
    return releaseNoticeReached(result.deliveries);
  } catch (error) {
    logError("Weekly attendance release notification failed", {
      labels: { event: "attendance_digest_notify_failed", digestId: String(input.digestId) },
      error,
    });
    return false;
  }
}
