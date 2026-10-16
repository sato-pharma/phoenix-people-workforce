// Recruitment — the notices the interview-request flow sends (owner, 2026-09-23).
//
//   · A NEW REQUEST reaches HR + the system admin — "Mina Masoud sent 2 CVs for Tuesday" — so they
//     phone the candidates and give each CV a time. In-app + Telegram.
//   · HR BOOKING the times tells the REQUESTER their interviews now have times, and tells the
//     INTERVIEWER a new interview is on their calendar. In-app + Telegram.
//
// The interviewer is then nagged until they respond by the existing reminder job
// (interview-reminders.ts), which stops the moment an outcome is recorded — that is the "pumping until
// he responds" the owner asked for. Nothing here emails a candidate; the calendar is the whole of it.
//
// Every send is BEST-EFFORT and swallowed: a request or a booking must still succeed when a notice
// cannot go out. Idempotency keys stop a repeat from telling anyone twice.

import { canonicalHrIdKey, hrIdForStorage } from "@/lib/hr-id";
import { createSystemNotification } from "@/lib/notifications/system";
import { resolveHrIdsForRole } from "@/lib/notifications/role-recipients";
import type { InterviewBooking, InterviewRequest } from "@/lib/recruitment/interview-calendar-types";
import { interviewCalendarHref } from "@/lib/recruitment/interview-calendar-types";
import { formatDayLong, formatTimeOfDay } from "@/lib/recruitment/interview-calendar-week";

const ADMIN_BASE = "/recruitment/interview-calendar";
const PORTAL_BASE = "/employee-portals/interview-calendar";
const MODULE = "recruitment";

/**
 * Who is told a request landed: the calendar's owners — the Super Admin and HR Operations, who phone
 * the candidates and give each a time — and the Talent Acquisition seat (HR Resourcing), who sees
 * every request in her notification center (owner, 2026-10-16: new CV received, interview requests,
 * accepted job offers). She reads the calendar but does not book it, so `owner` says which copy she gets.
 */
async function inboxRecipients(): Promise<Array<{ hrId: string; owner: boolean }>> {
  const [superAdmin, hrOps, talentAcquisition] = await Promise.all([
    resolveHrIdsForRole("Super Admin", "Interview request inbox recipients"),
    resolveHrIdsForRole("HR Operations", "Interview request inbox recipients"),
    resolveHrIdsForRole("HR Resourcing", "Interview request inbox recipients"),
  ]);
  const keyed = new Map<string, { hrId: string; owner: boolean }>();
  for (const [hrIds, owner] of [
    [superAdmin.hrIds, true],
    [hrOps.hrIds, true],
    [talentAcquisition.hrIds, false],
  ] as const) {
    for (const hrId of hrIds) {
      const key = canonicalHrIdKey(hrId);
      if (key && !keyed.has(key)) keyed.set(key, { hrId, owner });
    }
  }
  return Array.from(keyed.values());
}

function cvCountText(request: InterviewRequest): string {
  const count = request.items.length;
  return count === 1 ? "1 CV" : `${count} CVs`;
}

/** Tell HR + the system admin that a request landed. Best-effort; never throws. */
export async function notifyInterviewRequestCreated(request: InterviewRequest): Promise<void> {
  try {
    const recipients = await inboxRecipients();
    const requesterKey = canonicalHrIdKey(request.requestedByHrId);
    const day = formatDayLong(request.requestedDay);
    const href = interviewCalendarHref({ base: ADMIN_BASE, weekStart: request.requestedDay });
    const title = `${request.requestedByName} asked for ${request.items.length === 1 ? "an interview" : "interviews"} on ${day}`;
    const summary = `${request.requestedByName} sent ${cvCountText(request)} to interview on ${day}, with ${request.interviewerName} to conduct.`;
    // The owners are told what is theirs to do; Talent Acquisition is told what HR will do, because she
    // cannot give a CV its time herself.
    const ownerMessage = `${summary} Phone the candidates and give each a time.`;
    const awarenessMessage = `${summary} HR will phone the candidates and give each a time.`;
    await Promise.all(
      recipients
        // The requester does not need to be told about their own request, even if they are an admin.
        .filter(({ hrId }) => canonicalHrIdKey(hrId) !== requesterKey)
        .map(({ hrId, owner }) =>
          createSystemNotification({
            actionUrl: href,
            channels: ["in_app", "telegram"],
            eventType: "interview_request_created",
            message: owner ? ownerMessage : awarenessMessage,
            metadata: { idempotencyKey: `interview-request-created:${request.id}:${canonicalHrIdKey(hrId)}` },
            module: MODULE,
            priority: "high",
            recipientHrId: hrIdForStorage(hrId),
            recordId: request.id,
            telegram: { buttons: [{ label: "Open the interview calendar", url: href }] },
            title,
          }).catch(() => null),
        ),
    );
  } catch {
    // Best-effort: a request must still succeed when nobody could be notified.
  }
}

/**
 * HR has given the request's CVs times. Tell the requester their interviews are booked, and tell the
 * interviewer a new interview is on their calendar (the reminder job then nags them until they
 * respond). Best-effort; never throws.
 */
export async function notifyInterviewRequestScheduled(
  request: InterviewRequest,
  booking: InterviewBooking,
): Promise<void> {
  const day = formatDayLong(booking.dateKey);
  const time = formatTimeOfDay(booking.startMinutes);
  const bookedCount = request.items.filter((item) => item.booked).length;
  const remaining = request.pendingItemCount;

  // The requester — on their own (portal) calendar.
  try {
    const requesterHref = interviewCalendarHref({ base: PORTAL_BASE, open: booking.id, weekStart: booking.dateKey });
    const tail = remaining > 0 ? ` (${remaining} still to be timed)` : "";
    await createSystemNotification({
      actionUrl: requesterHref,
      channels: ["in_app", "telegram"],
      eventType: "interview_request_scheduled",
      message: `HR booked ${booking.candidateName}'s interview on ${day} at ${time}${tail}. It is on your interview calendar.`,
      metadata: { idempotencyKey: `interview-request-scheduled:${request.id}:${booking.id}` },
      module: MODULE,
      priority: "normal",
      recipientHrId: hrIdForStorage(request.requestedByHrId),
      recordId: request.id,
      telegram: { buttons: [{ label: "Open your interview calendar", url: requesterHref }] },
      title: `Interview booked — ${booking.candidateName} on ${day}`,
    }).catch(() => null);
    void bookedCount;
  } catch {
    // Best-effort.
  }

  // The interviewer — a new interview to conduct. One-shot here; the reminder job carries the pump.
  try {
    if (!request.interviewerHrId) return;
    const interviewerHref = interviewCalendarHref({ base: PORTAL_BASE, open: booking.id, weekStart: booking.dateKey });
    await createSystemNotification({
      actionUrl: interviewerHref,
      channels: ["in_app", "telegram"],
      eventType: "interview_assigned",
      message: `You are set to interview ${booking.candidateName} on ${day} at ${time} (${booking.platform === "zoom" ? "Zoom" : "In office"}). Please respond once it is done.`,
      metadata: { idempotencyKey: `interview-assigned:${booking.id}` },
      module: MODULE,
      priority: "high",
      recipientHrId: hrIdForStorage(request.interviewerHrId),
      recordId: booking.id,
      telegram: { buttons: [{ label: "Open the interview", url: interviewerHref }] },
      title: `New interview to conduct — ${booking.candidateName} on ${day}`,
    }).catch(() => null);
  } catch {
    // Best-effort.
  }
}
