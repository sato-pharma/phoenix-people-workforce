// How many days a person was EXPECTED to be at work inside an activity window.
//
// The engagement score used to divide active time by logged-in time, which is
// cookie lifetime, not a workload: the people who use Phoenix most are also the
// people who leave the tab open longest, so the denominator grew with the
// numerator and the score flattened (33 of 39 people landed in one band).
// A working-day baseline is a fixed yardstick instead, and it reuses the
// attendance engine's own weekend rule so the two cannot drift apart: a Medical
// Rep or District Manager gets a Friday-only weekend, everyone else Friday and
// Saturday.
//
// Deliberately NOT in v1: the confirmed national-holiday calendar. Reading it is
// async and hits Google, and a holiday moves every person by the same factor, so
// it changes the ranking not at all. If it is ever added, add it here — never
// with a second copy of the weekend rule.

import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";

const BUSINESS_TIMEZONE = "Africa/Cairo";
const cairoDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: BUSINESS_TIMEZONE,
  year: "numeric",
});

/** The Cairo calendar date an instant falls on, as YYYY-MM-DD. */
export function cairoDateKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = cairoDateFormatter.formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const key = `${value("year")}-${value("month")}-${value("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

/** Every Cairo calendar date touched by the window, inclusive at both ends. */
export function listCairoDatesInRange(fromIso: string, toIso: string): string[] {
  const from = cairoDateKey(fromIso);
  const to = cairoDateKey(toIso);
  if (!from || !to || from > to) return [];
  const dates: string[] = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (cursor.getTime() <= end.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Scheduled working days in the window for someone with this job title.
 *
 * Never returns 0 — a window of pure weekend would otherwise divide by zero and
 * hand everybody a perfect score.
 */
export function expectedWorkingDaysInRange(fromIso: string, toIso: string, jobTitle: string | null): number {
  let count = 0;
  for (const dateIso of listCairoDatesInRange(fromIso, toIso)) {
    if (isAttendanceScheduledWorkingDay({ dateIso, jobTitle })) count += 1;
  }
  return Math.max(1, count);
}

/**
 * A memoized counter for one window. The date list and each job title's answer
 * are computed once, so scoring 300 people costs one sweep, not 300.
 */
export function createWorkingDayBaseline(fromIso: string, toIso: string): (jobTitle: string | null) => number {
  const dates = listCairoDatesInRange(fromIso, toIso);
  const cache = new Map<string, number>();
  return (jobTitle: string | null) => {
    const key = String(jobTitle ?? "").trim().toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let count = 0;
    for (const dateIso of dates) {
      if (isAttendanceScheduledWorkingDay({ dateIso, jobTitle })) count += 1;
    }
    const expected = Math.max(1, count);
    cache.set(key, expected);
    return expected;
  };
}
