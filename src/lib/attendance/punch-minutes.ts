// Per-employee-day punch minutes for the digest generator.
//
// Mirrors the Cairo-timezone bucketing already proven in fingerprint-report.ts
// (localDateKey / localMinutesOfDay) but returns raw minute-of-day values keyed
// by (employeeHrId, dateIso) instead of display strings — exactly the shape the
// flexible-hours engine consumes.

import { getSupabaseAdmin } from "@/lib/supabase/server";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";

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

function utcBoundaryForLocalDate(date: string, dayOffset = 0): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day + dayOffset).toISOString();
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
  const PAGE_SIZE = 20000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("attendance_raw_punches")
      .select("employee_hr_id,punch_time")
      .not("employee_hr_id", "is", null)
      .in("employee_hr_id", normalizedHrIds)
      .gte("punch_time", utcBoundaryForLocalDate(input.dateFromIso))
      .lt("punch_time", utcBoundaryForLocalDate(input.dateToIso, 1))
      .order("punch_time", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) throw new Error(`Punch minutes lookup failed: ${error.message}`);
    const page = (data ?? []) as RawPunchRow[];
    punches.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
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
