/**
 * Interviews for the Company Activity Report (owner, 2026-11-18: "when the company activity report is
 * exported the interviews are not recorded as daily records — the company activity report must show
 * every record and be 100% full").
 *
 * Two sources, each read ONCE for the whole roster and range:
 *
 *   - the recruitment interview calendar (`ats_interview_bookings`), through the same reader and the same
 *     "who sat in it" rule the private calendar uses (`interviewAttendeesFor`): the lead interviewer
 *     unless he declined, and every panel member, each once. A manager the interview was only SHARED
 *     with did not sit in it, so it is not his record. A cancelled interview is a deleted row, so it is
 *     simply not here.
 *   - the interviews recorded on a Phoenix CRM "Interviews" day (`phoenix_crm_day_interviews`): the ones
 *     the person added by hand, and the calendar copies taken when the day was saved. A copy whose
 *     booking is still on the calendar for the same person is the SAME interview and is shown once;
 *     a copy whose booking was later cancelled is the only record left, so it stays.
 *
 * Shown, never judged: an interview is listed on its day and counted, and a day whose ONLY record is an
 * interview reads "Interview" instead of "No Entry" (reconcile.ts) — but nothing here feeds a deduction,
 * the private calendar's No Activity Recorded, or any payroll figure. This report drives none of them.
 *
 * Best-effort per source, like the holiday calendar: a source that cannot be read flips
 * `interviewSourcesReachable` to false, and the screen and the workbook SAY so — never a silent zero.
 */

import { hrIdLookupKeys } from "@/lib/hr-id";
import { interviewAttendeesFor } from "@/lib/private-calendar/interview-items";
import { privateCalendarHrIdKey } from "@/lib/private-calendar/logic";
import { listInterviewsForPrivateCalendar, type PrivateCalendarInterviewRow } from "@/lib/recruitment/interview-calendar";
import { interviewOutcomeLabels, PLATFORM_LABEL } from "@/lib/recruitment/interview-calendar-types";
import { addDays, cairoDateKey, cairoLocalToUtc, cairoMinutesOfDay } from "@/lib/recruitment/interview-calendar-week";
import { isIsoDate } from "@/lib/attendance/working-days";
import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { CompanyActivityInterviewDetail } from "@/lib/company-activity-report/types";

/** One interview recorded on a Phoenix CRM Interviews day, as the table stores it. */
export type CrmDayInterviewRow = {
  activity_date: string;
  person_hr_id: string | null;
  source: string | null;
  booking_id: string | null;
  candidate_name: string | null;
  scheduled_at: string | null;
  duration_minutes: number | null;
};

const CRM_DAY_INTERVIEW_COLUMNS = "id,activity_date,person_hr_id,source,booking_id,candidate_name,scheduled_at,duration_minutes";

function clock(minutes: number) {
  const wrapped = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

function clean(value: string | null | undefined) {
  const text = (value ?? "").trim();
  return text.length > 0 ? text : null;
}

function timeLabel(startsAt: Date, durationMinutes: number | null | undefined): string {
  const from = cairoMinutesOfDay(startsAt);
  const duration = Number.isFinite(durationMinutes) && Number(durationMinutes) > 0 ? Number(durationMinutes) : 0;
  return duration > 0 ? `${clock(from)} – ${clock(from + duration)}` : clock(from);
}

/** Who each spelling of an hr id belongs to, among the report's employees. */
function employeeLookup(employeeHrIds: readonly string[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const hrId of employeeHrIds) {
    for (const key of hrIdLookupKeys(hrId)) {
      const normalized = privateCalendarHrIdKey(key);
      if (normalized && !byKey.has(normalized)) byKey.set(normalized, hrId);
    }
  }
  return byKey;
}

export type CompanyActivityInterviewDays = Map<string, Map<string, CompanyActivityInterviewDetail[]>>;

/**
 * Pure — both sources already read. Keyed by the employee's hrId EXACTLY as the report's roster has it,
 * then by Cairo date; each day's interviews in time order. Only dates inside `startDate..endDate` and
 * only the roster's people are kept.
 */
export function buildCompanyActivityInterviewDays(input: {
  employeeHrIds: readonly string[];
  startDate: string;
  endDate: string;
  calendar: readonly PrivateCalendarInterviewRow[];
  crmDay: readonly CrmDayInterviewRow[];
}): CompanyActivityInterviewDays {
  const lookup = employeeLookup(input.employeeHrIds);
  const out: CompanyActivityInterviewDays = new Map();
  const seenBookings = new Set<string>();

  const push = (employeeHrId: string, dateIso: string, detail: CompanyActivityInterviewDetail) => {
    if (dateIso < input.startDate || dateIso > input.endDate) return;
    const byDate = out.get(employeeHrId) ?? new Map<string, CompanyActivityInterviewDetail[]>();
    const list = byDate.get(dateIso) ?? [];
    list.push(detail);
    byDate.set(dateIso, list);
    out.set(employeeHrId, byDate);
  };

  for (const attendance of interviewAttendeesFor(input.calendar, input.employeeHrIds)) {
    const employeeHrId = lookup.get(privateCalendarHrIdKey(attendance.hrId));
    if (!employeeHrId) continue;
    const { interview } = attendance;
    const startsAt = new Date(interview.startsAt);
    if (Number.isNaN(startsAt.getTime())) continue;
    const dateIso = cairoDateKey(startsAt);
    seenBookings.add(`${employeeHrId}|${interview.id}`);
    const where = [clean(interview.area), clean(interview.line)].filter(Boolean).join(" · ");
    push(employeeHrId, dateIso, {
      source: "calendar",
      startsAtIso: startsAt.toISOString(),
      timeLabel: timeLabel(startsAt, interview.durationMinutes),
      candidateName: clean(interview.candidateName) ?? "Unnamed candidate",
      jobTitle: clean(interview.jobTitle),
      where: where || null,
      platform: PLATFORM_LABEL[interview.platform] ?? null,
      part: attendance.isLead ? "Lead interviewer" : "Panel",
      outcome: interview.outcome ? interviewOutcomeLabels[interview.outcome] : null,
    });
  }

  for (const row of input.crmDay) {
    const employeeHrId = lookup.get(privateCalendarHrIdKey(row.person_hr_id));
    if (!employeeHrId || !isIsoDate(row.activity_date)) continue;
    // The calendar copy of a booking still on the calendar is the same interview — shown once, from the
    // calendar, which carries the outcome. A copy whose booking is gone is the only record, so it stays.
    if (row.booking_id && seenBookings.has(`${employeeHrId}|${row.booking_id}`)) continue;
    const startsAt = row.scheduled_at ? new Date(row.scheduled_at) : null;
    const validStart = startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt : null;
    push(employeeHrId, row.activity_date, {
      source: "phoenix_crm",
      startsAtIso: validStart ? validStart.toISOString() : `${row.activity_date}T23:59:59.999Z`,
      timeLabel: validStart ? timeLabel(validStart, row.duration_minutes) : null,
      candidateName: clean(row.candidate_name) ?? "Unnamed candidate",
      jobTitle: null,
      where: null,
      platform: null,
      part: "Recorded on the Phoenix CRM Interviews day",
      outcome: null,
    });
  }

  for (const byDate of out.values()) {
    for (const list of byDate.values()) {
      list.sort((a, b) => a.startsAtIso.localeCompare(b.startsAtIso) || a.candidateName.localeCompare(b.candidateName));
    }
  }
  return out;
}

export type CompanyActivityInterviewResult = {
  byEmployeeDay: CompanyActivityInterviewDays;
  /** False when either source could not be read — the report says so rather than show a zero. */
  reachable: boolean;
};

export async function loadCompanyActivityInterviews(input: {
  employeeHrIds: string[];
  dateFromIso: string;
  dateToIso: string;
}): Promise<CompanyActivityInterviewResult> {
  if (input.employeeHrIds.length === 0 || !isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) {
    return { byEmployeeDay: new Map(), reachable: true };
  }

  const [calendar, crmDay] = await Promise.all([
    // dateFrom..dateTo are Cairo days; the bookings are instants, so the window is Cairo midnight to Cairo midnight.
    listInterviewsForPrivateCalendar(cairoLocalToUtc(input.dateFromIso, 0), cairoLocalToUtc(addDays(input.dateToIso, 1), 0)).then(
      (rows) => ({ ok: true as const, rows }),
      (error: unknown) => {
        console.error("[company-activity-report] interview calendar could not be read", error);
        return { ok: false as const, rows: [] as PrivateCalendarInterviewRow[] };
      },
    ),
    fetchAllRows<CrmDayInterviewRow>(
      () =>
        getSupabaseAdmin()
          .from("phoenix_crm_day_interviews")
          .select(CRM_DAY_INTERVIEW_COLUMNS)
          .eq("is_test", false)
          .gte("activity_date", input.dateFromIso)
          .lte("activity_date", input.dateToIso),
      "id",
    ).then(
      (rows) => ({ ok: true as const, rows }),
      (error: unknown) => {
        console.error("[company-activity-report] Phoenix CRM day interviews could not be read", error);
        return { ok: false as const, rows: [] as CrmDayInterviewRow[] };
      },
    ),
  ]);

  return {
    byEmployeeDay: buildCompanyActivityInterviewDays({
      employeeHrIds: input.employeeHrIds,
      startDate: input.dateFromIso,
      endDate: input.dateToIso,
      calendar: calendar.rows,
      crmDay: crmDay.rows,
    }),
    reachable: calendar.ok && crmDay.ok,
  };
}
