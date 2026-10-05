// Phoenix Ranks — the five windows a rep is ranked over. PURE: no database, no clock.
//
// Owner, 2026-10-05: "the top of the day, the top of the week, the top of the month, the top of the
// quarter, the top of the semester". Every window is scored THROUGH YESTERDAY — the call rate's own
// ruling C1 (a day that is not over is never in the denominator with none of its calls in the
// numerator), so the board never ranks a half-lived day.
//
//   day       the last WORKING day on or before yesterday (Saturday to Wednesday, holidays out —
//             `isCallRateWorkingDay`, never a second rule). A Friday morning therefore shows
//             Wednesday's top, not a Thursday that holds no PM call by design.
//   week      Saturday to Friday, the Egyptian field week, through yesterday.
//   month     the calendar month, through yesterday.
//   quarter   Q1-Q4, through yesterday.
//   semester  January-June / July-December, through yesterday.

import { isCallRateWorkingDay, type CallRateHolidays } from "@/lib/crm/call-rate";
import { addDaysIso } from "@/lib/crm/dates";

export type RankWindowKind = "day" | "week" | "month" | "quarter" | "semester";

export const RANK_WINDOW_KINDS: readonly RankWindowKind[] = ["day", "week", "month", "quarter", "semester"];

/** The heading word for each window — what the tabs and the medals print. */
export const RANK_WINDOW_TITLES: Record<RankWindowKind, string> = {
  day: "Top of the day",
  week: "Top of the week",
  month: "Top of the month",
  quarter: "Top of the quarter",
  semester: "Top of the semester",
};

export const RANK_WINDOW_TABS: Record<RankWindowKind, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  quarter: "Quarter",
  semester: "Semester",
};

/** One calendar month's slice of a window — coverage and frequency are monthly ideas, prorated per slice. */
export type RankMonthSegment = { month: string; from: string; to: string; wholeMonth: boolean };

export type RankWindow = {
  kind: RankWindowKind;
  /** Stable key: `2026-10-04`, `wk-2026-10-03`, `2026-10`, `2026-Q4`, `2026-S2`. */
  key: string;
  from: string;
  /** Last day scored — the window's end, or yesterday while it is still running. */
  to: string;
  /** The window's own last day, before the yesterday cap. */
  end: string;
  label: string;
  running: boolean;
  segments: RankMonthSegment[];
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad2 = (value: number) => String(value).padStart(2, "0");

function partsOf(iso: string): { year: number; month: number; day: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)), day: Number(iso.slice(8, 10)) };
}

function weekdayOf(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

function lastDayOfMonth(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(last)}`;
}

/** "Sun 4 Oct" — never a raw ISO date on screen. */
export function dayLabel(iso: string): string {
  const { month, day } = partsOf(iso);
  return `${WEEKDAYS[weekdayOf(iso)]} ${day} ${MONTHS[month - 1]}`;
}

function shortDay(iso: string): string {
  const { month, day } = partsOf(iso);
  return `${day} ${MONTHS[month - 1]}`;
}

/** Splits [from, to] into one segment per calendar month. */
export function monthSegments(from: string, to: string): RankMonthSegment[] {
  if (from > to) return [];
  const segments: RankMonthSegment[] = [];
  let cursor = from;
  while (cursor <= to) {
    const { year, month } = partsOf(cursor);
    const monthStart = `${year}-${pad2(month)}-01`;
    const monthEnd = lastDayOfMonth(year, month);
    const segmentEnd = monthEnd < to ? monthEnd : to;
    segments.push({
      month: `${year}-${pad2(month)}`,
      from: cursor,
      to: segmentEnd,
      wholeMonth: cursor === monthStart && segmentEnd === monthEnd,
    });
    cursor = addDaysIso(monthEnd, 1);
  }
  return segments;
}

function build(kind: RankWindowKind, key: string, from: string, end: string, yesterday: string, label: string): RankWindow {
  const to = end < yesterday ? end : yesterday;
  return { kind, key, from, to, end, label, running: end > yesterday, segments: monthSegments(from, to) };
}

/** The last working day on or before `iso`, looking back at most three weeks. Null if none. */
export function lastWorkingDayOnOrBefore(iso: string, holidays?: CallRateHolidays): string | null {
  let cursor = iso;
  for (let step = 0; step < 21; step += 1) {
    if (isCallRateWorkingDay(cursor, holidays)) return cursor;
    cursor = addDaysIso(cursor, -1);
  }
  return null;
}

export function dayWindowOf(dayIso: string): RankWindow {
  return { kind: "day", key: dayIso, from: dayIso, to: dayIso, end: dayIso, label: dayLabel(dayIso), running: false, segments: monthSegments(dayIso, dayIso) };
}

/** Saturday on or before `iso`. */
export function weekStartOf(iso: string): string {
  const back = (weekdayOf(iso) + 1) % 7; // Sat=6 -> 0, Sun=0 -> 1, … Fri=5 -> 6
  return addDaysIso(iso, -back);
}

export function weekWindowOf(iso: string, yesterday: string): RankWindow {
  const from = weekStartOf(iso);
  const end = addDaysIso(from, 6);
  return build("week", `wk-${from}`, from, end, yesterday, `Week of ${shortDay(from)}`);
}

export function monthWindowOf(iso: string, yesterday: string): RankWindow {
  const { year, month } = partsOf(iso);
  return build("month", `${year}-${pad2(month)}`, `${year}-${pad2(month)}-01`, lastDayOfMonth(year, month), yesterday, `${MONTHS_LONG[month - 1]} ${year}`);
}

export function quarterWindowOf(iso: string, yesterday: string): RankWindow {
  const { year, month } = partsOf(iso);
  const quarter = Math.floor((month - 1) / 3) + 1;
  const firstMonth = (quarter - 1) * 3 + 1;
  return build("quarter", `${year}-Q${quarter}`, `${year}-${pad2(firstMonth)}-01`, lastDayOfMonth(year, firstMonth + 2), yesterday, `Q${quarter} ${year}`);
}

export function semesterWindowOf(iso: string, yesterday: string): RankWindow {
  const { year, month } = partsOf(iso);
  const half = month <= 6 ? 1 : 2;
  const firstMonth = half === 1 ? 1 : 7;
  return build(
    "semester",
    `${year}-S${half}`,
    `${year}-${pad2(firstMonth)}-01`,
    lastDayOfMonth(year, firstMonth + 5),
    yesterday,
    `${half === 1 ? "First" : "Second"} half ${year}`,
  );
}

/**
 * Every window that holds `anchorIso` (normally yesterday). The day window is the last WORKING day
 * on or before it; null when none is found (a three-week holiday — never in practice).
 */
export function windowsForAnchor(anchorIso: string, holidays?: CallRateHolidays): RankWindow[] {
  const windows: RankWindow[] = [];
  const workingDay = lastWorkingDayOnOrBefore(anchorIso, holidays);
  if (workingDay) windows.push(dayWindowOf(workingDay));
  windows.push(
    weekWindowOf(anchorIso, anchorIso),
    monthWindowOf(anchorIso, anchorIso),
    quarterWindowOf(anchorIso, anchorIso),
    semesterWindowOf(anchorIso, anchorIso),
  );
  return windows;
}

/** A stored window's own last day, from its kind and first day. */
export function windowEndOf(kind: RankWindowKind, from: string): string {
  const far = "9999-12-31";
  switch (kind) {
    case "day":
      return from;
    case "week":
      return weekWindowOf(from, far).end;
    case "month":
      return monthWindowOf(from, far).end;
    case "quarter":
      return quarterWindowOf(from, far).end;
    case "semester":
      return semesterWindowOf(from, far).end;
  }
}

/** True once the window's last day has been scored — only then is a #1 a title. */
export function isWindowClosed(kind: RankWindowKind, from: string, scoredTo: string): boolean {
  return scoredTo >= windowEndOf(kind, from);
}

/** The label a stored window prints, rebuilt from its kind and first day. */
export function windowLabelOf(kind: RankWindowKind, from: string): string {
  const far = "9999-12-31";
  switch (kind) {
    case "day":
      return dayLabel(from);
    case "week":
      return weekWindowOf(from, far).label;
    case "month":
      return monthWindowOf(from, far).label;
    case "quarter":
      return quarterWindowOf(from, far).label;
    case "semester":
      return semesterWindowOf(from, far).label;
  }
}

/** Every Cairo day in [from, to], inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let cursor = from; cursor <= to; cursor = addDaysIso(cursor, 1)) days.push(cursor);
  return days;
}
