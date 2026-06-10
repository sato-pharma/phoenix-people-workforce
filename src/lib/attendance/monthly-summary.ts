import { getSupabaseAdmin } from "@/lib/supabase/server";
import { getFingerprintAttendanceReport, type FingerprintReportRow } from "@/lib/attendance/fingerprint-report";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import {
  buildAttendanceCalendarContext,
  cairoTodayIso,
  classifyAttendanceDay,
  getApprovedLeaveDayMap,
  listIsoDatesInRange,
} from "@/lib/attendance/working-days";

export type MonthlyAttendanceSummaryRow = {
  absentDays: number;
  department: string;
  earlyLeaveCount: number;
  employeeHrId: string;
  employeeName: string;
  exceptionDays: number;
  expectedWorkingDays: number;
  holidayDays: number;
  jobTitle: string;
  lateCount: number;
  leaveDays: number;
  presentDays: number;
  singlePunchCount: number;
  totalDeductionDays: number;
  totalDeductionValue: number;
};

export type MonthlyAttendanceSummaryData = {
  dateFrom: string;
  dateTo: string;
  generatedAt: string;
  holidaySourceConnected: boolean;
  month: string;
  rows: MonthlyAttendanceSummaryRow[];
  totals: {
    absenceRate: number;
    absentDays: number;
    employees: number;
    expectedWorkingDays: number;
    lateCount: number;
    presentDays: number;
    totalDeductionDays: number;
  };
};

type MappingRow = { employee_hr_id: string | null };

type EmployeeMetadataRow = {
  department_id: number | null;
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
};

type DepartmentRow = { id: number; name: string | null };

function lastDayOfMonthIso(year: number, month: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function resolveSummaryMonth(month: string | undefined): string {
  if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return month;
  return cairoTodayIso().slice(0, 7);
}

/**
 * Per-employee attendance rollup for one calendar month. Scope is employees with
 * an active fingerprint device mapping — field staff without device access are
 * intentionally excluded so they are not reported absent.
 */
export async function getMonthlyAttendanceSummary(input: { month?: string } = {}): Promise<MonthlyAttendanceSummaryData> {
  const month = resolveSummaryMonth(input.month);
  const [yearText, monthText] = month.split("-");
  const todayIso = cairoTodayIso();
  const dateFrom = `${month}-01`;
  const monthEnd = lastDayOfMonthIso(Number(yearText), Number(monthText));
  const dateTo = monthEnd < todayIso ? monthEnd : todayIso;

  const emptyTotals = {
    absenceRate: 0,
    absentDays: 0,
    employees: 0,
    expectedWorkingDays: 0,
    lateCount: 0,
    presentDays: 0,
    totalDeductionDays: 0,
  };

  // Future month: nothing to report yet.
  if (dateFrom > todayIso) {
    return {
      dateFrom,
      dateTo: monthEnd,
      generatedAt: new Date().toISOString(),
      holidaySourceConnected: true,
      month,
      rows: [],
      totals: emptyTotals,
    };
  }

  const supabase = getSupabaseAdmin();
  const [mappingResult, employeeResult, departmentResult] = await Promise.all([
    supabase
      .from("attendance_device_user_map")
      .select("employee_hr_id")
      .eq("is_active", true)
      .not("employee_hr_id", "is", null),
    supabase
      .from("employees")
      .select("hr_id,full_name,job_title,department_id"),
    supabase
      .from("departments")
      .select("id,name"),
  ]);

  if (mappingResult.error) throw mappingResult.error;
  if (employeeResult.error) throw employeeResult.error;
  if (departmentResult.error) throw departmentResult.error;

  const rosterHrIds = Array.from(new Set(
    ((mappingResult.data ?? []) as MappingRow[])
      .map((row) => normalizeAttendanceHrId(row.employee_hr_id))
      .filter((value): value is string => Boolean(value)),
  ));

  const employeeMap = new Map<string, EmployeeMetadataRow>();
  for (const employee of (employeeResult.data ?? []) as EmployeeMetadataRow[]) {
    const hrId = normalizeAttendanceHrId(employee.hr_id);
    if (hrId) employeeMap.set(hrId, employee);
  }
  const departmentMap = new Map<number, string>(
    ((departmentResult.data ?? []) as DepartmentRow[]).map((row) => [row.id, row.name?.trim() ?? ""]),
  );

  const [report, context, leaveMap] = await Promise.all([
    getFingerprintAttendanceReport({ dateFrom, dateTo }),
    buildAttendanceCalendarContext({ dateFromIso: dateFrom, dateToIso: dateTo }),
    getApprovedLeaveDayMap({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds: rosterHrIds }),
  ]);

  // hrId -> dateIso -> engine row (engine rows only exist for days with punches).
  const rowsByEmployee = new Map<string, Map<string, FingerprintReportRow>>();
  for (const row of report.rows) {
    const hrId = normalizeAttendanceHrId(row.employeeHrId);
    if (!hrId) continue;
    const byDate = rowsByEmployee.get(hrId) ?? new Map<string, FingerprintReportRow>();
    byDate.set(row.dateIso, row);
    rowsByEmployee.set(hrId, byDate);
  }

  const monthDays = listIsoDatesInRange(dateFrom, dateTo);
  const summaryRows: MonthlyAttendanceSummaryRow[] = [];

  for (const hrId of rosterHrIds) {
    const employee = employeeMap.get(hrId);
    const jobTitle = employee?.job_title?.trim() ?? "";
    const byDate = rowsByEmployee.get(hrId) ?? new Map<string, FingerprintReportRow>();
    const leaveDates = leaveMap.get(hrId) ?? new Set<string>();

    let expectedWorkingDays = 0;
    let presentDays = 0;
    let leaveDays = 0;
    let holidayDays = 0;
    let lateCount = 0;
    let earlyLeaveCount = 0;
    let singlePunchCount = 0;
    let exceptionDays = 0;
    let totalDeductionDays = 0;
    let totalDeductionValue = 0;

    for (const dateIso of monthDays) {
      const day = classifyAttendanceDay({ context, dateIso, jobTitle });
      if (day.isFuture) continue;
      if (day.isHoliday && !day.isWeeklyOff) holidayDays += 1;
      if (!day.isExpectedWorkingDay) continue;
      if (leaveDates.has(dateIso)) {
        leaveDays += 1;
        continue;
      }

      expectedWorkingDays += 1;
      const row = byDate.get(dateIso);
      if (!row) continue;

      presentDays += 1;
      if (row.hasException) exceptionDays += 1;
      if (row.status === "Late") lateCount += 1;
      if (row.status === "Early leave") earlyLeaveCount += 1;
      if (row.status === "Single punch") singlePunchCount += 1;
      totalDeductionDays += Number(row.deductionDays) || 0;
      totalDeductionValue += Number(row.deductionValue) || 0;
    }

    summaryRows.push({
      absentDays: Math.max(0, expectedWorkingDays - presentDays),
      department: typeof employee?.department_id === "number"
        ? departmentMap.get(employee.department_id) ?? ""
        : "",
      earlyLeaveCount,
      employeeHrId: hrId,
      employeeName: employee?.full_name?.trim() || hrId,
      exceptionDays,
      expectedWorkingDays,
      holidayDays,
      jobTitle,
      lateCount,
      leaveDays,
      presentDays,
      singlePunchCount,
      totalDeductionDays: round2(totalDeductionDays),
      totalDeductionValue: round2(totalDeductionValue),
    });
  }

  summaryRows.sort((left, right) => left.employeeName.localeCompare(right.employeeName));

  const totals = summaryRows.reduce((acc, row) => {
    acc.absentDays += row.absentDays;
    acc.expectedWorkingDays += row.expectedWorkingDays;
    acc.lateCount += row.lateCount;
    acc.presentDays += row.presentDays;
    acc.totalDeductionDays += row.totalDeductionDays;
    return acc;
  }, { ...emptyTotals, employees: summaryRows.length });
  totals.totalDeductionDays = round2(totals.totalDeductionDays);
  totals.absenceRate = totals.expectedWorkingDays > 0
    ? round2((totals.absentDays / totals.expectedWorkingDays) * 100)
    : 0;

  return {
    dateFrom,
    dateTo,
    generatedAt: new Date().toISOString(),
    holidaySourceConnected: context.holidaySourceConnected,
    month,
    rows: summaryRows,
    totals,
  };
}
