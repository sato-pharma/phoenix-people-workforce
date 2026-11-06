// Per-employee-day punch minutes for the digest generator.
//
// Mirrors the Cairo-timezone bucketing already proven in fingerprint-report.ts
// (localDateKey / localMinutesOfDay) but returns raw minute-of-day values keyed
// by (employeeHrId, dateIso) instead of display strings — exactly the shape the
// flexible-hours engine consumes.

import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";

const punchTimeZone = process.env.ATTENDANCE_REPORT_TIME_ZONE || "Africa/Cairo";

export type EmployeeDayPunches = {
  firstPunchMinutes: number | null;
  lastPunchMinutes: number | null;
  /** Count of distinct visible punch times (matches the fingerprint-report definition of "usable punches"). */
  visiblePunchCount: number;
};

type RawPunchRow = {
  employee_hr_id: string | null;
  punch_time: string;
};

function localDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: punchTimeZone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function localMinutesOfDay(date: Date): number | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: punchTimeZone,
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const hour = value("hour");
  const minute = value("minute");
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

/**
 * Map<employeeHrId, Map<dateIso, EmployeeDayPunches>> for the given employees
 * and date range (inclusive, local Cairo calendar days). "Visible" punch times
 * are deduplicated by their Cairo-local minute-of-day, matching the same
 * "usable punch" definition the fingerprint report uses (so a missing-punch
 * classification here is consistent with the org-wide report).
 */
export async function loadEmployeeDayPunchMinutes(input: {
  dateFromIso: string;
  dateToIso: string;
  employeeHrIds: string[];
}): Promise<Map<string, Map<string, EmployeeDayPunches>>> {
  const result = new Map<string, Map<string, EmployeeDayPunches>>();
  const normalizedHrIds = Array.from(
    new Set(input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value))),
  );
  if (normalizedHrIds.length === 0) return result;

  const supabase = getSupabaseAdmin();
  const punches: RawPunchRow[] = [];
  // PostgREST folds every .in() value into the request URL; an unbatched array of a few hundred
  // ids can push the URL past undici's ~16KB header limit and throw "TypeError: fetch failed" /
  // HeadersOverflowError — callers pass company/site-wide rosters here, so batch the id filter
  // (each batch is then paged at PostgREST's own 1,000-row page, so no ceiling can end it early;
  // the id tiebreak keeps pages of equal punch times from losing or repeating a punch).
  for (let h = 0; h < normalizedHrIds.length; h += 100) {
    const hrIdBatch = normalizedHrIds.slice(h, h + 100);
    let page: RawPunchRow[];
    try {
      page = await fetchAllRows<RawPunchRow>(
        () =>
          supabase
            .from("attendance_raw_punches")
            .select("employee_hr_id,punch_time")
            .not("employee_hr_id", "is", null)
            .in("employee_hr_id", hrIdBatch)
            .gte("punch_time", cairoMidnightUtcIso(input.dateFromIso))
            .lt("punch_time", cairoMidnightUtcIso(input.dateToIso, 1))
            .order("punch_time", { ascending: true }),
        "id",
      );
    } catch (error) {
      throw new Error(`Punch minutes lookup failed: ${(error as { message?: string } | null)?.message ?? String(error)}`);
    }
    for (const row of page) punches.push(row);
  }

  // employeeHrId -> dateIso -> punch times that local day.
  const buckets = new Map<string, Map<string, Date[]>>();
  for (const punch of punches) {
    const hrId = normalizeAttendanceHrId(punch.employee_hr_id);
    if (!hrId) continue;
    const punchDate = new Date(punch.punch_time);
    const dateIso = localDateKey(punchDate);
    const byDate = buckets.get(hrId) ?? new Map<string, Date[]>();
    const times = byDate.get(dateIso) ?? [];
    times.push(punchDate);
    byDate.set(dateIso, times);
    buckets.set(hrId, byDate);
  }

  for (const [hrId, byDate] of buckets) {
    const output = result.get(hrId) ?? new Map<string, EmployeeDayPunches>();
    for (const [dateIso, times] of byDate) {
      times.sort((left, right) => left.getTime() - right.getTime());
      const firstPunch = times[0] ?? null;
      const lastPunch = times[times.length - 1] ?? null;
      // Dedup by Cairo-local minute-of-day (never the server host's timezone).
      const visibleTimes = new Set(times.map((time) => localMinutesOfDay(time)));

      output.set(dateIso, {
        firstPunchMinutes: firstPunch ? localMinutesOfDay(firstPunch) : null,
        lastPunchMinutes: lastPunch ? localMinutesOfDay(lastPunch) : null,
        visiblePunchCount: visibleTimes.size,
      });
    }
    result.set(hrId, output);
  }

  return result;
}

export type SingleDayPunchSummary = {
  firstPunchTime: string | null;
  lastPunchTime: string | null;
  visiblePunchCount: number;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function minutesToClock(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

/**
 * One employee's punch summary for a single Cairo-local calendar day, formatted to "HH:MM" —
 * the day-detail-view equivalent of loadEmployeeDayPunchMinutes, for the Team Calendar's
 * fingerprint-punch click-through (see field-workforce-visits-view.tsx). Returns null when
 * there's no punch that day (not an empty object) so callers can render an accurate empty
 * state.
 */
export async function loadSingleEmployeeDayPunchSummary(input: {
  dateIso: string;
  hrId: string;
}): Promise<SingleDayPunchSummary | null> {
  const byEmployee = await loadEmployeeDayPunchMinutes({
    dateFromIso: input.dateIso,
    dateToIso: input.dateIso,
    employeeHrIds: [input.hrId],
  });
  const hrKey = normalizeAttendanceHrId(input.hrId);
  const day = hrKey ? byEmployee.get(hrKey)?.get(input.dateIso) : undefined;
  if (!day) return null;
  return {
    firstPunchTime: minutesToClock(day.firstPunchMinutes),
    lastPunchTime: minutesToClock(day.lastPunchMinutes),
    visiblePunchCount: day.visiblePunchCount,
  };
}
