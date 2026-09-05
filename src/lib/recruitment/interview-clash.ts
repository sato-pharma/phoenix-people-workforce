// One interviewer cannot be in two interviews at once.
//
// ── WHY A WINDOW AND NOT AN OVERLAP ─────────────────────────────────────────────────────────────
//
// `ats_interviews` records `scheduled_at` and nothing else about time — there is no duration column
// and no end time. So a true overlap cannot be computed, and inventing a duration column to compute
// one would be a schema change made to satisfy a check rather than to record something real.
//
// What is computable is proximity: two interviews for the same person starting less than one slot
// apart. The slot is stated here as an assumption rather than buried as a magic number, because it
// IS an assumption — if interviews here routinely run ninety minutes, this is the line to move.
//
// STRICTLY LESS THAN, so back-to-back is allowed. Two interviews exactly a slot apart are a normal
// morning, and a check that refuses them would be switched off within a week — the same reason the
// requisition gate was measured against production before it was written.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────────────────────────
//
// It does not look at the candidate's side. A candidate double-booked with two different
// interviewers is a real problem too, but a rarer one, and every extra thing a guard refuses is
// another reason for somebody to stop using the scheduler. This refuses the case with no legitimate
// reading: one person, two candidates, the same moment.
//
// It also ignores interviews with no `scheduled_at`. Those are scorecard records written by
// recordScreeningOutcome — a CV or phone screen that happened, not a booking — and treating them as
// occupying a slot would refuse a real interview because somebody was screened that day.

export const INTERVIEW_SLOT_MINUTES = 60;

export type ScheduledInterview = {
  id: string;
  interviewerHrId: string | null;
  scheduledAt: string | null;
};

export type InterviewClash = {
  clashesWithInterviewId: string;
  clashesWithScheduledAt: string;
  minutesApart: number;
};

/** Same person, case- and padding-blind. HR ids are mixed case throughout this database. */
function samePerson(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = String(left ?? "").trim().toLowerCase();
  const b = String(right ?? "").trim().toLowerCase();
  return a.length > 0 && a === b;
}

/**
 * The interview this booking would clash with, or null if the interviewer is free.
 *
 * `existing` is every interview already on file for this interviewer; the caller decides how to
 * fetch them. `excludeInterviewId` lets a reschedule ignore the row it is moving, which otherwise
 * clashes with itself and makes rescheduling impossible.
 */
export function findInterviewClash(
  proposed: { interviewerHrId: string | null; scheduledAt: string | null },
  existing: readonly ScheduledInterview[],
  options: { excludeInterviewId?: string | null; slotMinutes?: number } = {},
): InterviewClash | null {
  const slotMinutes = options.slotMinutes ?? INTERVIEW_SLOT_MINUTES;

  // No interviewer or no time means nothing to clash with. A scorecard record has no scheduled_at,
  // and an unassigned interview has nobody to double-book.
  if (!proposed.interviewerHrId || !proposed.scheduledAt) return null;
  const proposedAt = Date.parse(proposed.scheduledAt);
  if (!Number.isFinite(proposedAt)) return null;

  for (const row of existing) {
    if (options.excludeInterviewId && row.id === options.excludeInterviewId) continue;
    if (!samePerson(row.interviewerHrId, proposed.interviewerHrId)) continue;
    if (!row.scheduledAt) continue;
    const at = Date.parse(row.scheduledAt);
    if (!Number.isFinite(at)) continue;

    const minutesApart = Math.abs(at - proposedAt) / 60_000;
    if (minutesApart < slotMinutes) {
      return {
        clashesWithInterviewId: row.id,
        clashesWithScheduledAt: row.scheduledAt,
        minutesApart: Math.round(minutesApart),
      };
    }
  }

  return null;
}

/**
 * The refusal, in the words the person scheduling will read.
 *
 * It names the time in Africa/Cairo because every time in this system is reported in Cairo, and a
 * UTC timestamp in a clash message is how somebody "fixes" a clash by moving the booking three
 * hours the wrong way.
 */
export function interviewClashMessage(clash: InterviewClash, interviewerName: string): string {
  const when = new Date(clash.clashesWithScheduledAt).toLocaleString("en-GB", {
    timeZone: "Africa/Cairo",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    `${interviewerName} already has an interview at ${when} (Cairo), ${clash.minutesApart} minutes `
    + `from this one. Move one of them, or assign a different interviewer.`
  );
}
