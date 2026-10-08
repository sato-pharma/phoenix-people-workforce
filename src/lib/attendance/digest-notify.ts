// Telling an employee about their weekly attendance review: a week released for an answer, and a
// disputed day decided.
//
// Owner rule 2026-09-17 (replacing 2026-09-15's "never email"): by email to the employee's own work
// address, by Telegram, and in-app — see attendance-digest-channels.ts. Email is named before
// Telegram on purpose: a permanent Telegram failure falls back to email only when email has not been
// tried yet, so the other order would email the employee twice. The release notice is sent ONLY when
// the Super Admin releases the week — the daily job that builds a week sends nothing. The decision
// notice is sent when a reviewer accepts or rejects a disputed day.
//
// Neither message carries an amount, and the decision notice does not quote the reviewer's note:
// Telegram is a lock-screen channel, and both are one tap away on the page.

import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import {
  buildDisputeDecidedMessage,
  buildWeekReleasedMessage,
  noticeReachedEmployee,
  noticeRecipientFactsFrom,
  releaseNoticeReached,
  type DeductionMethod,
  type NoticeRecipientFacts,
} from "@/lib/attendance/digest-rules.ts";
import { createSystemNotificationForRecipients } from "@/lib/notifications/system";
import { logError } from "@/lib/observability/log";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export { buildWeekReleasedMessage };

export const WEEKLY_ATTENDANCE_PORTAL_URL = "/employee-portals/attendance/digests";

/**
 * Whether the employee still works here, and whether they have an active login that has signed in
 * at least once. A signed-in session is read from `app_sessions`, which only a real password or
 * biometric sign-in writes; Supabase's own last-sign-in time is not, because an Employee login does
 * not open a Supabase session. Throws on a failed read: the caller then counts the employee as not
 * told, which leaves their days for HR rather than the deadline.
 */
async function loadNoticeRecipientFacts(employeeHrId: string): Promise<NoticeRecipientFacts> {
  const hrPattern = employeeHrId.trim().replace(/[\\%_]/g, (char) => `\\${char}`);
  const supabase = getSupabaseAdmin();
  const [employee, login, session] = await Promise.all([
    supabase.from("employees").select("employment_status").ilike("hr_id", hrPattern).limit(1).maybeSingle(),
    supabase.from("app_auth_users").select("hr_id").ilike("hr_id", hrPattern).eq("is_active", true).limit(1),
    supabase.from("app_sessions").select("id").ilike("hr_id", hrPattern).limit(1),
  ]);
  if (employee.error) throw employee.error;
  if (login.error) throw login.error;
  if (session.error) throw session.error;
  const status = (employee.data as { employment_status?: string | null } | null)?.employment_status;
  return noticeRecipientFactsFrom({
    onEmployeeFile: Boolean(employee.data),
    terminalStatus: isTerminalEmploymentStatus(status),
    activeLogin: (login.data ?? []).length > 0,
    hasSession: (session.data ?? []).length > 0,
  });
}

/**
 * Never throws: a notice that cannot be delivered must not undo a release already written.
 * Returns true only when the notice told someone who still works here — see releaseNoticeReached.
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
        channels: ["in_app", "email", "telegram"],
        // The employee the week describes is the only recipient; naming them as the subject too
        // keeps this on the "sensitive content to its own subject" path if the module is ever
        // listed as sensitive. It is also what copies their direct manager on the email (owner,
        // 2026-09-17: keep the manager's copy).
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
    // Read after sending: the notice goes to a leaver or a never-signed-in employee too, and only
    // whether it starts their deadline depends on these.
    return releaseNoticeReached(result.deliveries, await loadNoticeRecipientFacts(input.employeeHrId));
  } catch (error) {
    logError("Weekly attendance release notification failed", {
      labels: { event: "attendance_digest_notify_failed", digestId: String(input.digestId) },
      error,
    });
    return false;
  }
}

/**
 * Tell the REVIEWERS that an employee has disputed a day.
 *
 * Until 2026-10-09 nothing was sent at all: the employee wrote a reason into the line and it waited
 * for somebody to open the review page and notice. The recipients are passed in — the Super Admin
 * plus whoever is named in the review's own dispute_reviewer_hr_ids — so this module stays free of
 * digest-service, which would be a cycle. In-app and push only: the dispute itself is one tap away,
 * and a reviewer's lock screen is not the place for somebody else's attendance.
 *
 * Never throws: the dispute is already saved, and a notice that cannot be delivered must not make
 * the employee think their dispute was not filed.
 */
export async function notifyAttendanceDisputeFiled(input: {
  lineId: number;
  digestId: number;
  employeeHrId: string;
  employeeName: string | null;
  workDate: string;
  reason: string;
  reviewerHrIds: string[];
}): Promise<void> {
  const recipients = input.reviewerHrIds.filter(Boolean);
  if (recipients.length === 0) return;
  try {
    await createSystemNotificationForRecipients(
      {
        actionUrl: "/admin/disputes?kind=digest&case=" + encodeURIComponent(String(input.lineId)),
        category: "attendance_digest",
        channels: ["in_app", "push"],
        eventType: "dispute_filed",
        message: (input.employeeName ?? "An employee") + " disputed " + input.workDate + ': "' + input.reason + '"',
        metadata: {
          attendanceDigestId: input.digestId,
          attendanceDigestLineId: input.lineId,
          // A reviewer is not the data subject; the server addresses them deliberately.
          authorizedRecipient: true,
          employeeHrId: input.employeeHrId,
          idempotencyKey: "attendance_digest:line:" + input.lineId + ":dispute_filed",
        },
        module: "attendance_digest",
        priority: "normal",
        subjectHrId: input.employeeHrId,
        title: "Attendance dispute — " + input.workDate,
      },
      recipients,
    );
  } catch (error) {
    logError("Attendance dispute filed notification failed", {
      error,
      labels: { event: "attendance_dispute_filed_notify_failed", lineId: String(input.lineId) },
    });
  }
}

/**
 * Tell the employee how their disputed day was decided (owner, 2026-09-15; by email too since
 * 2026-09-17). Never throws: the decision is already saved, and a notice that cannot be delivered
 * must not make the reviewer think it was not. Returns true only when the notice reached the
 * employee through a real channel — see noticeReachedEmployee.
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
        channels: ["in_app", "email", "telegram"],
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
    // Nothing is deducted on this answer, so a leaver who was reached counts as told here.
    return noticeReachedEmployee(result.deliveries, await loadNoticeRecipientFacts(input.employeeHrId));
  } catch (error) {
    logError("Attendance dispute decision notification failed", {
      labels: { event: "attendance_dispute_notify_failed", digestId: String(input.digestId), lineId: String(input.lineId) },
      error,
    });
    return false;
  }
}
