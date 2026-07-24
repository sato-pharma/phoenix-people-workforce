import { getConfirmedNationalHolidays } from "@/lib/vacation/national-holidays";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";

const workingDaysTimeZone = process.env.ATTENDANCE_REPORT_TIME_ZONE || "Africa/Cairo";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string | null | undefined): value is string {
  return ISO_DATE_PATTERN.test(String(value ?? ""));
}

/** Today's date in the attendance report time zone (Cairo by default). */
export function cairoTodayIso(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: workingDaysTimeZone,
    year: "numeric",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function utcDate(dateIso: string): Date {
  return new Date(`${dateIso}T00:00:00Z`);
}

function isoFromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Inclusive list of ISO dates between two ISO dates. Returns [] for invalid or inverted ranges. */
export function listIsoDatesInRange(dateFromIso: string, dateToIso: string): string[] {
  if (!isIsoDate(dateFromIso) || !isIsoDate(dateToIso)) return [];
  const dates: string[] = [];
  const cursor = utcDate(dateFromIso);
  const end = utcDate(dateToIso);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(isoFromUtcDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** ISO-8601 week key ("2026-W23") plus the Monday that starts that week. */
export function isoWeekKey(dateIso: string): { key: string; weekStartIso: string } {
  const date = utcDate(dateIso);
  const dayOfWeek = date.getUTCDay() || 7; // Monday = 1 … Sunday = 7
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - (dayOfWeek - 1));
  // ISO week number: the week containing the first Thursday of the year is week 1.
  const thursday = new Date(monday);
  thursday.setUTCDate(monday.getUTCDate() + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDow = firstThursday.getUTCDay() || 7;
  const week1Monday = new Date(firstThursday);
  week1Monday.setUTCDate(firstThursday.getUTCDate() - (firstThursdayDow - 1));
  const weekNumber = Math.floor((monday.getTime() - week1Monday.getTime()) / (7 * 86_400_000)) + 1;
  return {
    key: `${isoYear}-W${String(weekNumber).padStart(2, "0")}`,
    weekStartIso: isoFromUtcDate(monday),
  };
}

export type AttendanceCalendarContext = {
  /** ISO date -> holiday name. Multi-day holidays are expanded per day. */
  holidaysByDate: Map<string, string>;
  /** False when the public-holiday calendar could not be reached (company holidays still apply). */
  holidaySourceConnected: boolean;
  todayIso: string;
};

function listMonthsInRange(dateFromIso: string, dateToIso: string): Array<{ month: number; year: number }> {
  const months: Array<{ month: number; year: number }> = [];
  const [fromYear, fromMonth] = dateFromIso.split("-").map(Number);
  const [toYear, toMonth] = dateToIso.split("-").map(Number);
  let year = fromYear;
  let month = fromMonth;
  while (year < toYear || (year === toYear && month <= toMonth)) {
    months.push({ month, year });
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * Loads national + company holidays for every month overlapping the range and
 * expands them into a per-day lookup. getConfirmedNationalHolidays (raw
 * source + admin-confirmed observed/postponed overrides applied) is cached,
 * so repeated calls within a request are cheap.
 */
export async function buildAttendanceCalendarContext(input: {
  dateFromIso: string;
  dateToIso: string;
}): Promise<AttendanceCalendarContext> {
  const holidaysByDate = new Map<string, string>();
  let holidaySourceConnected = true;

  if (isIsoDate(input.dateFromIso) && isIsoDate(input.dateToIso)) {
    const months = listMonthsInRange(input.dateFromIso, input.dateToIso);
    const results = await Promise.all(
      months.map((entry) => getConfirmedNationalHolidays(entry).catch(() => null)),
    );
    for (const result of results) {
      if (!result) {
        holidaySourceConnected = false;
        continue;
      }
      if (!result.connected) holidaySourceConnected = false;
      for (const holiday of result.holidays) {
        const endDate = holiday.endDate ?? holiday.startDate;
        for (const dateIso of listIsoDatesInRange(holiday.startDate, endDate)) {
          if (!holidaysByDate.has(dateIso)) holidaysByDate.set(dateIso, holiday.name);
        }
      }
    }
  }

  return { holidaysByDate, holidaySourceConnected, todayIso: cairoTodayIso() };
}

export type AttendanceDayClassification = {
  dateIso: string;
  holidayName: string | null;
  isFuture: boolean;
  isHoliday: boolean;
  isWeeklyOff: boolean;
  /** A day attendance is expected: not in the future, not a holiday, not a weekly off. */
  isExpectedWorkingDay: boolean;
};

/**
 * Classifies one calendar day for one employee. When a policy defines custom
 * weekdays, only those weekdays are expected; otherwise the company weekend
 * policy is used.
 */
export function classifyAttendanceDay(input: {
  context: AttendanceCalendarContext;
  dateIso: string;
  jobTitle?: string | null;
  workingWeekdays?: unknown;
}): AttendanceDayClassification {
  const holidayName = input.context.holidaysByDate.get(input.dateIso) ?? null;
  const isFuture = input.dateIso > input.context.todayIso;
  const isHoliday = holidayName != null;
  const isWeeklyOff = !isAttendanceScheduledWorkingDay({
    dateIso: input.dateIso,
    jobTitle: input.jobTitle ?? null,
    workingWeekdays: input.workingWeekdays,
  });
  return {
    dateIso: input.dateIso,
    holidayName,
    isFuture,
    isHoliday,
    isWeeklyOff,
    isExpectedWorkingDay: !isFuture && !isHoliday && !isWeeklyOff,
  };
}

type ApprovedLeaveRow = {
  employee_hr_id: string | null;
  end_date: string | null;
  start_date: string | null;
};

/**
 * Approved leave days per employee within the range (dates clamped to the range,
 * HR IDs normalized). Used to exclude approved leave from absence counting.
 */
export async function getApprovedLeaveDayMap(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds?: string[];
}): Promise<Map<string, Set<string>>> {
  const leaveByEmployee = new Map<string, Set<string>>();
  if (!isIsoDate(input.dateFromIso) || !isIsoDate(input.dateToIso)) return leaveByEmployee;

  const supabase = getSupabaseAdmin();
  const normalizedFilter = (input.employeeHrIds ?? [])
    .map((value) => normalizeAttendanceHrId(value))
    .filter((value): value is string => Boolean(value));

  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — callers pass company/site-wide rosters here, so batch when filtered.
  const rows: ApprovedLeaveRow[] = [];
  if (normalizedFilter.length > 0) {
    for (let i = 0; i < normalizedFilter.length; i += 100) {
      const batch = normalizedFilter.slice(i, i + 100);
      const { data, error } = await supabase
        .from("v2_vacation_requests")
        .select("employee_hr_id,start_date,end_date")
        .eq("status", "approved")
        .lte("start_date", input.dateToIso)
        .gte("end_date", input.dateFromIso)
        .in("employee_hr_id", batch);
      if (error) throw new Error(`Approved leave lookup failed: ${error.message}`);
      rows.push(...((data ?? []) as ApprovedLeaveRow[]));
    }
  } else {
    const { data, error } = await supabase
      .from("v2_vacation_requests")
      .select("employee_hr_id,start_date,end_date")
      .eq("status", "approved")
      .lte("start_date", input.dateToIso)
      .gte("end_date", input.dateFromIso);
    if (error) throw new Error(`Approved leave lookup failed: ${error.message}`);
    rows.push(...((data ?? []) as ApprovedLeaveRow[]));
  }

  for (const row of rows) {
    const hrId = normalizeAttendanceHrId(row.employee_hr_id);
    if (!hrId || !isIsoDate(row.start_date) || !isIsoDate(row.end_date)) continue;
    const clampedFrom = row.start_date > input.dateFromIso ? row.start_date : input.dateFromIso;
    const clampedTo = row.end_date < input.dateToIso ? row.end_date : input.dateToIso;
    if (clampedFrom > clampedTo) continue;
    const existing = leaveByEmployee.get(hrId) ?? new Set<string>();
    for (const dateIso of listIsoDatesInRange(clampedFrom, clampedTo)) {
      existing.add(dateIso);
    }
    leaveByEmployee.set(hrId, existing);
  }

  return leaveByEmployee;
}
