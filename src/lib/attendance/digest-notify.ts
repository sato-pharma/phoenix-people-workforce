// Telling an employee about their weekly attendance review: a week released for an answer, and a
// disputed day decided.
//
// Owner rules 2026-09-15: in-app and Telegram, never email (hard-blocked in
// attendance-digest-channel-guard.ts). The release notice is sent ONLY when the Super Admin
// releases the week — the daily job that builds a week sends nothing. The decision notice is sent
// when a reviewer accepts or rejects a disputed day.
//
// Neither message carries an amount, and the decision notice does not quote the reviewer's note:
// Telegram is a lock-screen channel, and both are one tap away on the page.

import {
  buildDisputeDecidedMessage,
  buildWeekReleasedMessage,
  releaseNoticeReached,
  type DeductionMethod,
} from "@/lib/attendance/digest-rules.ts";
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

/**
 * Tell the employee how their disputed day was decided (owner, 2026-09-15 — "Yes, in-app and
 * Telegram"). Never throws: the decision is already saved, and a notice that cannot be delivered
 * must not make the reviewer think it was not. Returns true only when in-app or Telegram took the
 * notice — see releaseNoticeReached.
 */
export async function notifyAttendanceDisputeDecided(input: {
  digestId: number;
  lineId: number;
  employeeHrId: string;
  workDate: string;
  upheld: boolean;
  appliedMethod: DeductionMethod | null;
  chosenMethod: DeductionMethod | null;
  balanceRefusal: string | null;
  hasReviewerNote: boolean;
}): Promise<boolean> {
  try {
    const { title, message } = buildDisputeDecidedMessage(input);
    const result = await createSystemNotificationForRecipients(
      {
        category: "attendance_digest",
        module: "attendance_digest",
        eventType: "dispute_decided",
        // No deadline rides on this one, unlike the release notice.
        priority: "normal",
        actionUrl: WEEKLY_ATTENDANCE_PORTAL_URL,
        channels: ["in_app", "telegram"],
        subjectHrId: input.employeeHrId,
        title,
        message,
        metadata: {
          employeeHrId: input.employeeHrId,
          attendanceDigestId: input.digestId,
          attendanceDigestLineId: input.lineId,
          // One notice per decided day: a retried request cannot tell the same employee twice.
          idempotencyKey: `attendance_digest:line:${input.lineId}:dispute_decided`,
        },
      },
      [input.employeeHrId],
    );
    return releaseNoticeReached(result.deliveries);
  } catch (error) {
    logError("Attendance dispute decision notification failed", {
      labels: { event: "attendance_dispute_notify_failed", digestId: String(input.digestId), lineId: String(input.lineId) },
      error,
    });
    return false;
  }
}
