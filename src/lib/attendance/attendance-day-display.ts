import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";

// How the employee's own fingerprint pages (Attendance Analytics, My Attendance) READ a day.
// Display only: no deduction, status or payroll figure is computed here — the fingerprint report
// and the flexible-hours engine decide those, and this module only counts and words what they said.

/** The status a working day with no punch at all is shown under. Never "Absent": no punch is not proof of absence. */
export const NO_RECORD_STATUS = "No record";

function minutesOf(value: string | null | undefined): number {
  const minutes = Number.parseInt(value ?? "", 10);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

/**
 * A day the card "Late / early" counts: it carries late or early-leave minutes, whatever status the
 * engine gave it. Counting by status alone missed every day that was BOTH late and short — the
 * engine labels that "Short day" when the shortfall's penalty is the larger, so on 11 Oct 2026 a
 * day 242 min late sat in the rows while the card read 0. The card now counts what the rows show.
 */
export function isLateOrEarlyDay(row: { earlyLeaveMinutes?: string | null; lateMinutes?: string | null }): boolean {
  return minutesOf(row.lateMinutes) > 0 || minutesOf(row.earlyLeaveMinutes) > 0;
}

export function countLateOrEarlyDays(
  rows: ReadonlyArray<{ earlyLeaveMinutes?: string | null; lateMinutes?: string | null }>,
): number {
  return rows.filter(isLateOrEarlyDay).length;
}

/** "08:14" → "8h14m", the way the attendance policy card already writes a duration. Anything else is returned as given. */
export function workedHoursLabel(value: string | null | undefined): string {
  const match = /^(\d{1,3}):(\d{2})$/.exec((value ?? "").trim());
  if (!match) return value ?? "";
  return `${Number(match[1])}h${match[2]}m`;
}

function eachDate(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${toIso}T00:00:00Z`);
  for (let at = Date.parse(`${fromIso}T00:00:00Z`); Number.isFinite(at) && at <= end; at += 86_400_000) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

/**
 * The working days in the range that have no fingerprint row at all, so the day list can show them
 * as "No record" instead of silently skipping them. Left out, deliberately:
 *   - today and later — a day is never judged before it ends;
 *   - the employee's weekly off (his policy's working weekdays, else the field-force weekend rule);
 *   - a confirmed national holiday.
 * These rows are never counted in any card and never called absent — an ingestion gap would
 * otherwise read as a run of absences (the August 2026 fabricated-absence defect).
 */
export function noRecordWorkingDays(input: {
  dateFrom: string;
  dateTo: string;
  holidayDates?: Iterable<string>;
  jobTitle?: string | null;
  recordedDates: Iterable<string>;
  todayIso: string;
  workingWeekdays?: unknown;
}): string[] {
  const recorded = new Set(input.recordedDates);
  const holidays = new Set(input.holidayDates ?? []);
  return eachDate(input.dateFrom, input.dateTo).filter(
    (dateIso) =>
      dateIso < input.todayIso &&
      !recorded.has(dateIso) &&
      !holidays.has(dateIso) &&
      isAttendanceScheduledWorkingDay({ dateIso, jobTitle: input.jobTitle, workingWeekdays: input.workingWeekdays }),
  );
}

export type NoRecordDay = { noRecord: true; rawDate: string };

/**
 * The fingerprint rows with the "No record" days slotted in, in the rows' own order (the report
 * lists newest first; a list of one row or none is taken as newest first too). A date that has a
 * row is never doubled by a no-record entry.
 */
export function mergeNoRecordDays<Row extends { rawDate: string }>(
  rows: ReadonlyArray<Row>,
  noRecordDates: ReadonlyArray<string> | null | undefined,
): Array<Row | NoRecordDay> {
  const recorded = new Set(rows.map((row) => row.rawDate));
  const extra: NoRecordDay[] = (noRecordDates ?? [])
    .filter((rawDate) => !recorded.has(rawDate))
    .map((rawDate) => ({ noRecord: true, rawDate }));
  if (extra.length === 0) return [...rows];
  const ascending = rows.length > 1 && rows[0].rawDate < rows[rows.length - 1].rawDate;
  return [...rows, ...extra].sort((a, b) =>
    ascending ? a.rawDate.localeCompare(b.rawDate) : b.rawDate.localeCompare(a.rawDate),
  );
}

export function isNoRecordDay(row: { rawDate: string } | NoRecordDay): row is NoRecordDay {
  return (row as NoRecordDay).noRecord === true;
}
