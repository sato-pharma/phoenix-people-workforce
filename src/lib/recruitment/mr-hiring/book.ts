// Recruitment / Medical Rep hiring — booking an interview of one round.
//
// It wraps the calendar's own `createInterviewBooking`, so every rule of the calendar still holds
// (who may book, the Zoom meeting from the Sato Pharma account, the change history, the invitation
// the calendar then offers) and adds only what the workflow asks:
//   * the round, the job title "Medical Representative" and the in-person place on the booking (§5);
//   * §3 for the 1st interview — Cairo or Giza in person, anywhere else on Zoom, or a phone call
//     (owner, 7 Nov 2026), which makes no Zoom meeting (inputs.ts);
//   * §4 for the DSM interview — the CV reaches the DSM through Phoenix, by the existing send, when it
//     has not been sent to that DSM already;
//   * the notice to everyone on the interview (§4), which a booking made straight on the calendar
//     never sent.
// HR books (the HR Manager or Talent Acquisition). The candidate must be on the step the round
// belongs to — or, for the joint final, on the 3rd interview it replaces (§7's "or").

import type { AccessContext } from "@/lib/auth/permissions";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { forbiddenError, notFoundError, validationError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { sendCandidatesToManager } from "@/lib/recruitment/candidates";
import { createInterviewBooking, interviewCalendarCaller, updateInterviewBooking } from "@/lib/recruitment/interview-calendar";
import type { InterviewBooking } from "@/lib/recruitment/interview-calendar-types";
import { mayBookMrInterview, mrViewer } from "@/lib/recruitment/mr-hiring/access";
import { loadMrCandidate } from "@/lib/recruitment/mr-hiring/facts-db";
import { parseMrBookingInput, type MrBookingInput } from "@/lib/recruitment/mr-hiring/inputs";
import { notifyMrInterviewBooked } from "@/lib/recruitment/mr-hiring/notify";
import { mrBookingRefusal } from "@/lib/recruitment/mr-hiring/rows";
import { mrHiringStage, mrReschedulableBooking, type MrStage } from "@/lib/recruitment/mr-hiring/stage";
import { MR_JOB_TITLE, MR_LINE_LABELS } from "@/lib/recruitment/mr-hiring/vocabulary";

export type MrBookingResult = { booking: InterviewBooking; notice: string | null; stage: MrStage };

export async function bookMrInterview(access: AccessContext, candidateId: string, raw: unknown): Promise<MrBookingResult> {
  let input: MrBookingInput;
  try {
    input = parseMrBookingInput(raw);
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : "Check the interview details and try again.");
  }
  const viewer = mrViewer(access);
  if (!mayBookMrInterview(viewer)) throw forbiddenError("HR books the Medical Rep interviews.");
  const record = await loadMrCandidate(candidateId);
  if (!record) throw notFoundError("This candidate is not in the Medical Rep hiring list.");
  const refusal = mrBookingRefusal(mrHiringStage(record.facts), input.round);
  if (refusal) throw validationError(refusal);

  // The 1st interview is HR's own: with nobody named, the person booking it conducts it.
  const interviewerHrId = input.interviewerHrId ?? (input.round === "hr_first" ? access.hrId : null);
  const caller = await interviewCalendarCaller(access);
  const { booking, notice } = await createInterviewBooking(caller, {
    area: record.area,
    candidateId,
    dateKey: input.dateKey,
    durationMinutes: input.durationMinutes,
    interviewRound: input.round,
    interviewerHrId,
    jobTitle: MR_JOB_TITLE,
    // The line HR confirmed at the 1st interview, on every later interview of the candidate.
    line: record.line ? MR_LINE_LABELS[record.line] : null,
    location: input.location,
    notes: input.notes,
    panelistHrIds: input.panelistHrIds,
    platform: input.platform,
    startMinutes: input.startMinutes,
  });

  const notices: string[] = notice ? [notice] : [];
  // §4 — the CV goes to the DSM through Phoenix. Sent after the booking saved, so a refused booking
  // never sends a CV; a send that fails is said plainly rather than undoing the interview.
  if (input.round === "dsm" && booking.interviewerHrId && canonicalHrIdKey(record.sentToHrId ?? "") !== canonicalHrIdKey(booking.interviewerHrId)) {
    try {
      await sendCandidatesToManager(access, [candidateId], booking.interviewerHrId, { areaName: record.area, jobTitle: MR_JOB_TITLE }, record.area);
    } catch (error) {
      logError("Medical Rep hiring: the CV could not be sent to the DSM after booking", {
        error,
        labels: { bookingId: booking.id, event: "mr_hiring_dsm_send_failed" },
      });
      notices.push("The interview is booked, but the CV could not be sent to the DSM — send it from the CV.");
    }
  }

  await notifyMrInterviewBooked({
    bookingId: booking.id,
    candidateId,
    candidateName: record.name,
    location: booking.location,
    platform: booking.platform,
    recipientHrIds: [booking.interviewerHrId, ...booking.panelists.map((member) => member.hrId)],
    round: input.round,
    startsAt: booking.startsAt,
  });

  const after = await loadMrCandidate(candidateId);
  return { booking, notice: notices.join(" ") || null, stage: mrHiringStage(after?.facts ?? record.facts) };
}

/**
 * Change the day, time, length, way or place of a Medical Rep interview that is booked and not yet
 * held (owner, 7 Nov 2026: "I set up the time for the interview as a phone call. Make me able to
 * change this time"). The round and the interviewer stay as booked; the calendar's own
 * `updateInterviewBooking` applies every calendar rule (who may move it, the Zoom meeting, the change
 * history, a phone call only on the 1st interview). Everyone on the interview is told the new time —
 * never by email, never the candidate.
 */
export async function rescheduleMrInterview(access: AccessContext, candidateId: string, raw: unknown): Promise<MrBookingResult> {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const bookingId = typeof body.bookingId === "string" ? body.bookingId.trim() : "";
  if (!bookingId) throw validationError("Choose the interview to change.");
  const viewer = mrViewer(access);
  if (!mayBookMrInterview(viewer)) throw forbiddenError("HR changes the Medical Rep interviews.");
  const record = await loadMrCandidate(candidateId);
  if (!record) throw notFoundError("This candidate is not in the Medical Rep hiring list.");
  const existing = mrReschedulableBooking(mrHiringStage(record.facts), bookingId);
  if (!existing) throw validationError("Only the interview booked and not yet held can be changed here.");

  let input: MrBookingInput;
  try {
    input = parseMrBookingInput({ ...body, interviewerHrId: existing.interviewerHrId, round: existing.round });
  } catch (error) {
    throw validationError(error instanceof Error ? error.message : "Check the interview details and try again.");
  }
  const caller = await interviewCalendarCaller(access);
  const booking = await updateInterviewBooking(caller, existing.id, {
    dateKey: input.dateKey,
    durationMinutes: input.durationMinutes,
    location: input.location,
    platform: input.platform,
    startMinutes: input.startMinutes,
  });

  if (booking.startsAt !== existing.startsAt || booking.platform !== existing.platform || booking.location !== existing.location) {
    await notifyMrInterviewBooked({
      bookingId: booking.id,
      candidateId,
      candidateName: record.name,
      location: booking.location,
      movedFrom: existing.startsAt,
      platform: booking.platform,
      recipientHrIds: [booking.interviewerHrId, ...booking.panelists.map((member) => member.hrId)],
      round: input.round,
      startsAt: booking.startsAt,
    });
  }

  const after = await loadMrCandidate(candidateId);
  return { booking, notice: null, stage: mrHiringStage(after?.facts ?? record.facts) };
}
