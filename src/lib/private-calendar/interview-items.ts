/**
 * INTERVIEWS ON THE PRIVATE CALENDAR — owner, 2026-10-29: *"also if he have an interview from calendar
 * throw it in his private calendars"*.
 *
 * Every interview on the recruitment interview calendar lands on the private calendar of each person who
 * sits in it: the lead interviewer (unless he declined it — he answered "I can't", so he is not expected
 * there) and every panel member, each once. A manager the interview was only SHARED with watches it; he
 * does not sit in it, so his calendar does not carry it. A cancelled interview is a deleted row, so it
 * simply drops off.
 *
 * 🔴 ONE INTERVIEW IS DISPLAY ONLY; TWO OR MORE IN ONE HALF ARE THAT HALF DAY WORKED (owner, 2026-11-18,
 * replacing the display-only rule of 2026-10-29 for that case). A half is the morning (starts before
 * 1 PM Cairo) or the afternoon (from 1 PM); the rule is `interview-halves.ts`. Each item carries its
 * `interviewHalf`, `isCovered` counts them, and the company-wide deductions pass and
 * `loadProvenWorkedDays` read the same bookings through `loadInterviewHalfDays`, which THROWS — a
 * silent "no interviews" there would be a charge. The Phoenix CRM "Interviews" day activity still
 * counts as before.
 *
 * 🔴 AN INTERVIEW THAT DID NOT HAPPEN PROVES NOTHING (`interviewProofRefusal`): one marked Didn't come
 * (or one of its reasons — Will reschedule, No answer, Withdrew) stays on the calendar and covers no
 * half; and nobody proves his own day with an interview he put on the calendar himself after it had
 * started. HR's back-dated booking for him still counts (owner, 8 Nov 2026: "don't block anything").
 *
 * Best-effort, like every other calendar source: a failed read answers `ready: false` (the screen then
 * says the source could not be read) and never throws the whole month away.
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import { privateCalendarHrIdKey, privateCalendarSourceLabels, type PrivateCalendarItem } from "@/lib/private-calendar/logic";
import { listInterviewsForPrivateCalendar, type PrivateCalendarInterviewRow } from "@/lib/recruitment/interview-calendar";
import { interviewOutcomeGroup, PLATFORM_LABEL } from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, cairoLocalToUtc, cairoMinutesOfDay } from "@/lib/recruitment/interview-calendar-week";
import { interviewHalfOf, selectInterviewHalfDays, type InterviewHalfDay } from "@/lib/private-calendar/interview-halves";

const INTERVIEW_BOOKINGS_TABLE = "ats_interview_bookings";

/** One interview, one attendee: who sits in it and in what part. */
export type InterviewAttendance = { interview: PrivateCalendarInterviewRow; hrId: string; isLead: boolean };

function clock(minutes: number) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function clean(value: string | null | undefined) {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

/**
 * Why this interview proves no half day for this attendee, or null when it can. Pure.
 *
 * Not when the candidate did not come (Didn't come or one of its reasons: no interview took place), and
 * not for the person who put it on the calendar himself after it had started.
 */
export function interviewProofRefusal(interview: PrivateCalendarInterviewRow, hrId: string): string | null {
  if (interviewOutcomeGroup(interview.outcome ?? null) === "did_not_come") {
    return "The candidate did not come, so it counts toward no half day.";
  }
  const bookedLateBy = privateCalendarHrIdKey(interview.bookedLateByHrId ?? null);
  if (bookedLateBy && bookedLateBy === privateCalendarHrIdKey(hrId)) {
    return "It was put on the calendar by this person after it had started, so it counts toward no half day.";
  }
  return null;
}

/** One interview attendance as a calendar item. Pure, so the shape is pinned by a test with no database. */
export function mapInterviewToPrivateCalendarItem(attendance: InterviewAttendance): PrivateCalendarItem {
  const { interview, hrId, isLead } = attendance;
  const refusal = interviewProofRefusal(interview, hrId);
  const startsAt = new Date(interview.startsAt);
  const date = cairoDateKey(startsAt);
  const from = cairoMinutesOfDay(startsAt);
  const duration = Number.isFinite(interview.durationMinutes) && interview.durationMinutes > 0 ? interview.durationMinutes : 0;
  const time = duration > 0 ? `${clock(from)} – ${clock(from + duration)}` : clock(from);
  const role = clean(interview.jobTitle);
  const where = [clean(interview.area), clean(interview.line)].filter(Boolean).join(" · ");
  const detailLines = [`Candidate: ${interview.candidateName}`];
  if (role) detailLines.push(`Role: ${role}`);
  if (where) detailLines.push(`Area and line: ${where}`);
  detailLines.push(`Platform: ${PLATFORM_LABEL[interview.platform]}`);
  detailLines.push(`Your part: ${isLead ? "Lead interviewer" : "Panel"}`);
  return {
    activityKind: "interview",
    approvalImpact: refusal
      ? `Shown from the recruitment interview calendar. ${refusal}`
      : "Shown from the recruitment interview calendar. Two or more interviews in the morning (starting before 1 PM) or in the afternoon (from 1 PM) count as that half day worked; a single interview does not.",
    chipLines: [`${time} Interview`, ...(role ? [role] : [])],
    description: null,
    detailLines,
    employeeDepartmentName: null,
    employeeHrId: hrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: null,
    endDate: date,
    exceptionFlags: [],
    id: `interview-${interview.id}-${privateCalendarHrIdKey(hrId)}`,
    // No half for an interview that proves nothing — `isCovered` counts only the items that carry one.
    ...(refusal ? {} : { interviewHalf: interviewHalfOf(from) }),
    managerName: null,
    severity: "info",
    source: "interview",
    sourceLabel: privateCalendarSourceLabels.interview,
    // Never the booking id: the detail panel prints a record id, and he reads names, never codes.
    sourceRecordId: null,
    sourceSystem: "Recruitment interview calendar",
    sourceTable: INTERVIEW_BOOKINGS_TABLE,
    startDate: date,
    status: isLead ? "Lead interviewer" : "Panel",
    time,
    title: role ? `Interview — ${role}` : "Interview",
  };
}

/**
 * Who sits in each interview, kept to these people. Pure; matches every spelling of an hr id the booking
 * may hold. The lead first unless he declined, then each panel member; nobody twice. A manager the
 * interview was only shared with is never here — the row does not even carry him.
 */
export function interviewAttendeesFor(interviews: readonly PrivateCalendarInterviewRow[], hrIds: readonly string[]): InterviewAttendance[] {
  const wanted = new Set<string>();
  for (const hrId of hrIds) {
    for (const key of hrIdLookupKeys(hrId)) wanted.add(privateCalendarHrIdKey(key));
  }
  wanted.delete("");
  const out: InterviewAttendance[] = [];
  for (const interview of interviews) {
    const leadKey = privateCalendarHrIdKey(interview.leadHrId);
    const seen = new Set<string>();
    for (const hrId of [interview.leadDeclined ? null : interview.leadHrId, ...interview.panelHrIds]) {
      const key = privateCalendarHrIdKey(hrId);
      if (!key || seen.has(key) || !wanted.has(key)) continue;
      seen.add(key);
      out.push({ hrId: hrId as string, interview, isLead: !interview.leadDeclined && Boolean(leadKey) && key === leadKey });
    }
  }
  return out;
}

function nextDay(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function interviewsInCairoDays(start: string, end: string) {
  // start..end are Cairo days; the bookings are instants, so the window is Cairo midnight to Cairo midnight.
  return listInterviewsForPrivateCalendar(cairoLocalToUtc(start, 0), cairoLocalToUtc(nextDay(end), 0));
}

/**
 * The interview items for these people. `strict` is for the company-wide deductions pass: a failed
 * read THROWS there, because an interview that covers a half day and is silently missing is a charge.
 * Every calendar screen reads best-effort and says the source could not be read.
 */
export async function loadInterviewPrivateCalendarItems(
  hrIds: readonly string[],
  start: string,
  end: string,
  options: { strict?: boolean } = {},
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  if (hrIds.length === 0) return { items: [], ready: true };
  try {
    const interviews = await interviewsInCairoDays(start, end);
    return { items: interviewAttendeesFor(interviews, hrIds).map(mapInterviewToPrivateCalendarItem), ready: true };
  } catch (error) {
    if (options.strict) throw error;
    console.error("[private-calendar] interviews could not be read", error);
    return { items: [], ready: false };
  }
}

/** Everyone who sits in each interview — the lead unless he declined, and each panel member. Pure. */
export function everyInterviewAttendance(interviews: readonly PrivateCalendarInterviewRow[]): InterviewAttendance[] {
  const hrIds = interviews.flatMap((interview) => [interview.leadHrId ?? "", ...interview.panelHrIds]).filter(Boolean);
  return interviewAttendeesFor(interviews, hrIds);
}

/** The person-days whose interviews cover a half day, from the attendances. Pure. */
export function interviewHalfDaysFromAttendances(attendances: readonly InterviewAttendance[]): InterviewHalfDay[] {
  return selectInterviewHalfDays(
    attendances.filter(({ hrId, interview }) => interviewProofRefusal(interview, hrId) === null).map(({ hrId, interview }) => {
      const startsAt = new Date(interview.startsAt);
      return { date: cairoDateKey(startsAt), half: interviewHalfOf(cairoMinutesOfDay(startsAt)), hrId, interviewId: interview.id };
    }),
    privateCalendarHrIdKey,
  );
}

/**
 * Every person-day in the window on which two or more interviews cover a half, for the deduction
 * readers (`loadProvenWorkedDays`). FAILS CLOSED: it throws, and nothing here catches.
 */
export async function loadInterviewHalfDays(input: { end: string; start: string }): Promise<InterviewHalfDay[]> {
  return interviewHalfDaysFromAttendances(everyInterviewAttendance(await interviewsInCairoDays(input.start, input.end)));
}
