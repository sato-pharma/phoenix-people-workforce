import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getFingerprintAttendanceReport, type FingerprintReportRow } from "@/lib/attendance/fingerprint-report";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import {
  buildAttendanceCalendarContext,
  cairoTodayIso,
  classifyAttendanceDay,
  getApprovedLeaveDayMap,
  isoWeekKey,
  listIsoDatesInRange,
  type AttendanceCalendarContext,
} from "@/lib/attendance/working-days";

export type AttendanceAnalyticsData = {
  chronicLate: Array<{
    department: string;
    employeeHrId: string;
    employeeName: string;
    lateDays: number;
    lateRate: number;
    presentDays: number;
    totalLateMinutes: number;
  }>;
  dataUnavailable: string[];
  departments: Array<{
    absenceRate: number;
    department: string;
    expectedDays: number;
    headcount: number;
    lateDays: number;
    lateRate: number;
    presentDays: number;
  }>;
  today: {
    absentees: Array<{ department: string; employeeHrId: string; employeeName: string }>;
    dateIso: string;
    expectedCount: number;
    holidayName: string | null;
    isWorkingDay: boolean;
    onLeaveCount: number;
    punchedInCount: number;
  };
  weeklyTrend: Array<{
    absenceRate: number;
    expectedDays: number;
    isoWeek: string;
    lateDays: number;
    lateRate: number;
    presentDays: number;
    weekStartIso: string;
  }>;
  windowFrom: string;
  windowTo: string;
};

type MappingRow = { employee_hr_id: string | null };

type EmployeeMetadataRow = {
  department_id: number | null;
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
};

type DepartmentRow = { id: number; name: string | null };

type RosterEmployee = {
  department: string;
  employeeName: string;
  hrId: string;
  jobTitle: string;
};

const CHRONIC_LATE_WINDOW_DAYS = 30;
const CHRONIC_LATE_MIN_DAYS = 3;
const TREND_WEEKS = 8;

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

function monthSlices(dateFromIso: string, dateToIso: string): Array<{ from: string; to: string }> {
  const slices: Array<{ from: string; to: string }> = [];
  let cursor = dateFromIso;
  while (cursor <= dateToIso) {
    const [year, month] = cursor.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const sliceEnd = monthEnd < dateToIso ? monthEnd : dateToIso;
    slices.push({ from: cursor, to: sliceEnd });
    const next = new Date(Date.UTC(year, month, 1));
    cursor = next.toISOString().slice(0, 10);
  }
  return slices;
}

function shiftIsoDate(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Company-wide attendance analytics for device-mapped employees: today's
 * snapshot, chronic late offenders (last 30 days), department rollup (last 30
 * days), and an 8-week trend. The fingerprint engine is invoked once per
 * calendar-month slice to stay inside its punch-row cap.
 */
export async function getAttendanceAnalytics(): Promise<AttendanceAnalyticsData> {
  const dataUnavailable: string[] = [];
  const todayIso = cairoTodayIso();
  const currentWeekMonday = isoWeekKey(todayIso).weekStartIso;
  const windowFrom = shiftIsoDate(currentWeekMonday, -7 * (TREND_WEEKS - 1));
  const windowTo = todayIso;

  const supabase = getSupabaseAdmin();
  const [mappingResult, employeeResult, departmentResult] = await Promise.all([
    supabase
      .from("attendance_device_user_map")
      .select("employee_hr_id")
      .eq("is_active", true)
      .not("employee_hr_id", "is", null),
    supabase.from("employees").select("hr_id,full_name,job_title,department_id"),
    supabase.from("departments").select("id,name"),
  ]);

  if (mappingResult.error) throw mappingResult.error;
  if (employeeResult.error) throw employeeResult.error;
  if (departmentResult.error) throw departmentResult.error;

  const employeeMap = new Map<string, EmployeeMetadataRow>();
  for (const employee of (employeeResult.data ?? []) as EmployeeMetadataRow[]) {
    const hrId = normalizeAttendanceHrId(employee.hr_id);
    if (hrId) employeeMap.set(hrId, employee);
  }
  const departmentMap = new Map<number, string>(
    ((departmentResult.data ?? []) as DepartmentRow[]).map((row) => [row.id, row.name?.trim() ?? ""]),
  );

  const roster: RosterEmployee[] = Array.from(new Set(
    ((mappingResult.data ?? []) as MappingRow[])
      .map((row) => normalizeAttendanceHrId(row.employee_hr_id))
      .filter((value): value is string => Boolean(value)),
  )).map((hrId) => {
    const employee = employeeMap.get(hrId);
    return {
      department: typeof employee?.department_id === "number"
        ? departmentMap.get(employee.department_id) || "Unassigned"
        : "Unassigned",
      employeeName: employee?.full_name?.trim() || hrId,
      hrId,
      jobTitle: employee?.job_title?.trim() ?? "",
    };
  });

  // One engine call per calendar-month slice (punch query is capped per call).
  const slices = monthSlices(windowFrom, windowTo);
  const [sliceReports, context, leaveMap] = await Promise.all([
    Promise.all(slices.map((slice) => getFingerprintAttendanceReport({ dateFrom: slice.from, dateTo: slice.to }))),
    buildAttendanceCalendarContext({ dateFromIso: windowFrom, dateToIso: windowTo }),
    getApprovedLeaveDayMap({ dateFromIso: windowFrom, dateToIso: windowTo, employeeHrIds: roster.map((entry) => entry.hrId) }),
  ]);

  // hrId -> dateIso -> engine row.
  const rowsByEmployee = new Map<string, Map<string, FingerprintReportRow>>();
  for (const report of sliceReports) {
    for (const row of report.rows) {
      const hrId = normalizeAttendanceHrId(row.employeeHrId);
      if (!hrId) continue;
      const byDate = rowsByEmployee.get(hrId) ?? new Map<string, FingerprintReportRow>();
      byDate.set(row.dateIso, row);
      rowsByEmployee.set(hrId, byDate);
    }
  }

  const today = buildTodaySnapshot({ context, leaveMap, roster, rowsByEmployee, todayIso });

  const lateWindowFrom = shiftIsoDate(todayIso, -(CHRONIC_LATE_WINDOW_DAYS - 1));
  const effectiveLateFrom = lateWindowFrom > windowFrom ? lateWindowFrom : windowFrom;

  let chronicLate: AttendanceAnalyticsData["chronicLate"] = [];
  let departments: AttendanceAnalyticsData["departments"] = [];
  try {
    const perEmployee = aggregatePerEmployee({
      context,
      dateFromIso: effectiveLateFrom,
      dateToIso: todayIso,
      leaveMap,
      roster,
      rowsByEmployee,
    });

    chronicLate = perEmployee
      .filter((entry) => entry.lateDays >= CHRONIC_LATE_MIN_DAYS)
      .map((entry) => ({
        department: entry.department,
        employeeHrId: entry.hrId,
        employeeName: entry.employeeName,
        lateDays: entry.lateDays,
        lateRate: entry.presentDays > 0 ? round1((entry.lateDays / entry.presentDays) * 100) : 0,
        presentDays: entry.presentDays,
        totalLateMinutes: entry.totalLateMinutes,
      }))
      .sort((left, right) => right.lateDays - left.lateDays || right.totalLateMinutes - left.totalLateMinutes);

    const byDepartment = new Map<string, { expectedDays: number; headcount: number; lateDays: number; presentDays: number }>();
    for (const entry of perEmployee) {
      const bucket = byDepartment.get(entry.department) ?? { expectedDays: 0, headcount: 0, lateDays: 0, presentDays: 0 };
      bucket.expectedDays += entry.expectedDays;
      bucket.headcount += 1;
      bucket.lateDays += entry.lateDays;
      bucket.presentDays += entry.presentDays;
      byDepartment.set(entry.department, bucket);
    }
    departments = Array.from(byDepartment.entries())
      .map(([department, bucket]) => ({
        absenceRate: bucket.expectedDays > 0
          ? round1(((bucket.expectedDays - bucket.presentDays) / bucket.expectedDays) * 100)
          : 0,
        department,
        expectedDays: bucket.expectedDays,
        headcount: bucket.headcount,
        lateDays: bucket.lateDays,
        lateRate: bucket.presentDays > 0 ? round1((bucket.lateDays / bucket.presentDays) * 100) : 0,
        presentDays: bucket.presentDays,
      }))
      .sort((left, right) => right.absenceRate - left.absenceRate);
  } catch (error) {
    dataUnavailable.push(error instanceof Error ? `30-day aggregates unavailable: ${error.message}` : "30-day aggregates unavailable.");
  }

  let weeklyTrend: AttendanceAnalyticsData["weeklyTrend"] = [];
  try {
    const byWeek = new Map<string, { expectedDays: number; lateDays: number; presentDays: number; weekStartIso: string }>();
    for (const dateIso of listIsoDatesInRange(windowFrom, windowTo)) {
      const week = isoWeekKey(dateIso);
      if (!byWeek.has(week.key)) {
        byWeek.set(week.key, { expectedDays: 0, lateDays: 0, presentDays: 0, weekStartIso: week.weekStartIso });
      }
      const bucket = byWeek.get(week.key)!;
      for (const employee of roster) {
        const day = classifyAttendanceDay({ context, dateIso, jobTitle: employee.jobTitle });
        if (!day.isExpectedWorkingDay) continue;
        if (leaveMap.get(employee.hrId)?.has(dateIso)) continue;
        bucket.expectedDays += 1;
        const row = rowsByEmployee.get(employee.hrId)?.get(dateIso);
        if (!row) continue;
        bucket.presentDays += 1;
        if (row.status === "Late") bucket.lateDays += 1;
      }
    }
    weeklyTrend = Array.from(byWeek.entries())
      .map(([isoWeek, bucket]) => ({
        absenceRate: bucket.expectedDays > 0
          ? round1(((bucket.expectedDays - bucket.presentDays) / bucket.expectedDays) * 100)
          : 0,
        expectedDays: bucket.expectedDays,
        isoWeek,
        lateDays: bucket.lateDays,
        lateRate: bucket.presentDays > 0 ? round1((bucket.lateDays / bucket.presentDays) * 100) : 0,
        presentDays: bucket.presentDays,
        weekStartIso: bucket.weekStartIso,
      }))
      .sort((left, right) => left.weekStartIso.localeCompare(right.weekStartIso));
  } catch (error) {
    dataUnavailable.push(error instanceof Error ? `Weekly trend unavailable: ${error.message}` : "Weekly trend unavailable.");
  }

  if (!context.holidaySourceConnected) {
    dataUnavailable.push("Public-holiday calendar unreachable — holidays may be counted as working days.");
  }

  return { chronicLate, dataUnavailable, departments, today, weeklyTrend, windowFrom, windowTo };
}

function buildTodaySnapshot(input: {
  context: AttendanceCalendarContext;
  leaveMap: Map<string, Set<string>>;
  roster: RosterEmployee[];
  rowsByEmployee: Map<string, Map<string, FingerprintReportRow>>;
  todayIso: string;
}): AttendanceAnalyticsData["today"] {
  const { context, leaveMap, roster, rowsByEmployee, todayIso } = input;
  const absentees: AttendanceAnalyticsData["today"]["absentees"] = [];
  let expectedCount = 0;
  let punchedInCount = 0;
  let onLeaveCount = 0;
  let isWorkingDay = false;
  let holidayName: string | null = null;

  for (const employee of roster) {
    const day = classifyAttendanceDay({ context, dateIso: todayIso, jobTitle: employee.jobTitle });
    holidayName = day.holidayName ?? holidayName;
    if (!day.isWeeklyOff && !day.isHoliday) isWorkingDay = true;
    if (!day.isExpectedWorkingDay) continue;
    if (leaveMap.get(employee.hrId)?.has(todayIso)) {
      onLeaveCount += 1;
      continue;
    }
    expectedCount += 1;
    const punched = rowsByEmployee.get(employee.hrId)?.has(todayIso) ?? false;
    if (punched) {
      punchedInCount += 1;
    } else {
      absentees.push({
        department: employee.department,
        employeeHrId: employee.hrId,
        employeeName: employee.employeeName,
      });
    }
  }

  absentees.sort((left, right) => left.employeeName.localeCompare(right.employeeName));

  return {
    absentees,
    dateIso: todayIso,
    expectedCount,
    holidayName,
    isWorkingDay,
    onLeaveCount,
    punchedInCount,
  };
}

function aggregatePerEmployee(input: {
  context: AttendanceCalendarContext;
  dateFromIso: string;
  dateToIso: string;
  leaveMap: Map<string, Set<string>>;
  roster: RosterEmployee[];
  rowsByEmployee: Map<string, Map<string, FingerprintReportRow>>;
}) {
  const days = listIsoDatesInRange(input.dateFromIso, input.dateToIso);
  return input.roster.map((employee) => {
    let expectedDays = 0;
    let presentDays = 0;
    let lateDays = 0;
    let totalLateMinutes = 0;

    for (const dateIso of days) {
      const day = classifyAttendanceDay({ context: input.context, dateIso, jobTitle: employee.jobTitle });
      if (!day.isExpectedWorkingDay) continue;
      if (input.leaveMap.get(employee.hrId)?.has(dateIso)) continue;
      expectedDays += 1;
      const row = input.rowsByEmployee.get(employee.hrId)?.get(dateIso);
      if (!row) continue;
      presentDays += 1;
      if (row.status === "Late") {
        lateDays += 1;
        totalLateMinutes += Number(row.lateMinutes) || 0;
      }
    }

    return {
      department: employee.department,
      employeeName: employee.employeeName,
      expectedDays,
      hrId: employee.hrId,
      lateDays,
      presentDays,
      totalLateMinutes,
    };
  });
}
