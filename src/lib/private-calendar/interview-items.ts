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
 * 🔴 DISPLAY ONLY. An interview NEVER clears "No Activity Recorded" (it is not in `isCovered`): that
 * reading feeds the No Records Activity deductions, and an hour's interview booked for someone is not a
 * record that the day was worked. The day he spends on interviews is recorded as the Phoenix CRM
 * "Interviews" day activity (#6670), which is what counts. That is also why the company-wide deductions
 * pass (`getCompanyNoActivityDays`) does not read this source at all.
 *
 * Best-effort, like every other calendar source: a failed read answers `ready: false` (the screen then
 * says the source could not be read) and never throws the whole month away.
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import { privateCalendarHrIdKey, privateCalendarSourceLabels, type PrivateCalendarItem } from "@/lib/private-calendar/logic";
import { listInterviewsForPrivateCalendar, type PrivateCalendarInterviewRow } from "@/lib/recruitment/interview-calendar";
import { PLATFORM_LABEL } from "@/lib/recruitment/interview-calendar-types";
import { cairoDateKey, cairoLocalToUtc, cairoMinutesOfDay } from "@/lib/recruitment/interview-calendar-week";

export const INTERVIEW_BOOKINGS_TABLE = "ats_interview_bookings";

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

/** One interview attendance as a calendar item. Pure, so the shape is pinned by a test with no database. */
export function mapInterviewToPrivateCalendarItem(attendance: InterviewAttendance): PrivateCalendarItem {
  const { interview, hrId, isLead } = attendance;
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
    approvalImpact:
      "Shown from the recruitment interview calendar. It does not clear No Activity Recorded — record the day's Interviews activity in Phoenix CRM for that.",
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

export async function loadInterviewPrivateCalendarItems(
  hrIds: readonly string[],
  start: string,
  end: string,
): Promise<{ items: PrivateCalendarItem[]; ready: boolean }> {
  if (hrIds.length === 0) return { items: [], ready: true };
  try {
    // start..end are Cairo days; the bookings are instants, so the window is Cairo midnight to Cairo midnight.
    const interviews = await listInterviewsForPrivateCalendar(cairoLocalToUtc(start, 0), cairoLocalToUtc(nextDay(end), 0));
    return { items: interviewAttendeesFor(interviews, hrIds).map(mapInterviewToPrivateCalendarItem), ready: true };
  } catch (error) {
    console.error("[private-calendar] interviews could not be read", error);
    return { items: [], ready: false };
  }
}
