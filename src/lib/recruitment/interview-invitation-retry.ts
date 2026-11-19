import { canonicalHrIdKey } from "@/lib/hr-id";
import type { FollowUpGate, InterviewInvitationFollowUp } from "@/lib/notifications/durable-email-follow-up";
import { recruitmentDb } from "@/lib/recruitment/db";

/**
 * AN INTERVIEW INVITATION THE OUTBOX SENDS LATE (REC-048 phase 2, 19 Nov 2026).
 *
 * The Interview Calendar's "Send" writes the invitation to the outbox and sends it at once; the person
 * reads straight away whether it went, and the invitation log says "failed" when it did not. The drain
 * then retries the SAME stored invitation. These two steps keep that honest:
 *
 *  - BEFORE the retry, the booking is read again. An interview that was cancelled (its row deleted),
 *    moved to another time, given another interviewer (for the interviewer's own invitation), or that
 *    has already begun is NOT invited to — the stored words would be wrong. `interviewInvitationRetryVerdict`
 *    is the pure rule.
 *  - AFTER a late send, the invitation log gains its "sent" line, so nobody presses Send a second time
 *    for an invitation that already went.
 */

const BOOKINGS = "ats_interview_bookings";
const INVITATIONS = "ats_interview_invitations";

type BookingNow = { interviewer_hr_id: string | null; starts_at: string } | null;

/** The rule, pure: the booking as it stands now against the invitation stored at the press. */
export function interviewInvitationRetryVerdict(
  booking: BookingNow,
  followUp: InterviewInvitationFollowUp,
  now: Date = new Date(),
): FollowUpGate {
  if (!booking) {
    return { decision: "skip", reason: "The interview was cancelled after this invitation failed, so it was not sent." };
  }
  const startsNow = Date.parse(booking.starts_at);
  if (!Number.isFinite(startsNow) || startsNow !== Date.parse(followUp.startsAt)) {
    return { decision: "skip", reason: "The interview was moved after this invitation failed, so the older invitation was not sent." };
  }
  if (startsNow <= now.getTime()) {
    return { decision: "skip", reason: "The interview has already begun, so the invitation was not sent." };
  }
  if (
    followUp.recipient === "interviewer" &&
    canonicalHrIdKey(booking.interviewer_hr_id ?? "") !== canonicalHrIdKey(followUp.interviewerHrId ?? "")
  ) {
    return { decision: "skip", reason: "The interview has another interviewer now, so the older invitation was not sent." };
  }
  return { decision: "proceed" };
}

export async function checkInterviewInvitationRetry(followUp: InterviewInvitationFollowUp): Promise<FollowUpGate> {
  const { data, error } = await recruitmentDb()
    .from(BOOKINGS)
    .select("starts_at,interviewer_hr_id")
    .eq("id", followUp.bookingId)
    .maybeSingle();
  // A read that fails throws, and the caller leaves the row queued — a cancelled interview is never
  // assumed to still stand.
  if (error) throw error;
  return interviewInvitationRetryVerdict((data as BookingNow) ?? null, followUp);
}

export async function completeInterviewInvitationRetry(followUp: InterviewInvitationFollowUp, _providerMessageId: string | null): Promise<void> {
  const { error } = await recruitmentDb().from(INVITATIONS).insert({
    booking_id: followUp.bookingId,
    channel: "email",
    destination: followUp.destination,
    detail: "Sent by the outbox after the first try failed.",
    kind: followUp.invitationKind,
    recipient: followUp.recipient,
    sent_by_hr_id: followUp.sentByHrId,
    status: "sent",
  });
  if (error) throw error;
}
