import { getAttendanceExceptionMap } from "@/lib/attendance/exceptions";
import { getFingerprintAttendanceReport, type FingerprintReportRow } from "@/lib/attendance/fingerprint-report";
import { normalizeAttendanceHrId, resolveActiveAttendancePolicy } from "@/lib/attendance/metrics";
import { loadAttendancePolicyGroups } from "@/lib/attendance/policy-groups";
import { getAttendanceRoster, isWithinEmploymentSpan } from "@/lib/attendance/roster";
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

export const attendanceMonthlyCycleNote =
  "Attendance reporting cycle note: payroll attendance months run from day 25 to day 25.";

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
 * Per-employee attendance rollup for one calendar month. Scope is the shared
 * attendance roster (see roster.ts): device-mapped head-office employees only —
 * field staff (medical reps, district managers) and exited employees are
 * excluded so they are not reported absent.
 */
export async function getMonthlyAttendanceSummary(
  input: { month?: string; employeeHrIds?: string[] } = {},
): Promise<MonthlyAttendanceSummaryData> {
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

  const fullRoster = await getAttendanceRoster({ dateFromIso: dateFrom, dateToIso: dateTo });
  const scopeHrIds = input.employeeHrIds
    ? new Set(input.employeeHrIds.map((id) => normalizeAttendanceHrId(id)).filter((value): value is string => Boolean(value)))
    : null;
  const roster = scopeHrIds ? fullRoster.filter((entry) => scopeHrIds.has(entry.hrId)) : fullRoster;

  const [report, context, leaveMap, policyRows, exceptionMap] = await Promise.all([
    // Intentionally unscoped: only rows for hrIds present in the (already-scoped)
    // `roster` are ever read out of this report below, and monthly-summary never
    // reads `report.policyDetails`. Do not add employeeHrIds here — it would be
    // redundant and this call feeds other unscoped internal aggregation elsewhere.
    getFingerprintAttendanceReport({ dateFrom, dateTo }),
    buildAttendanceCalendarContext({ dateFromIso: dateFrom, dateToIso: dateTo }),
    getApprovedLeaveDayMap({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds: roster.map((entry) => entry.hrId) }),
    loadAttendancePolicyGroups({ activeOnly: true }),
    getAttendanceExceptionMap(roster.map((entry) => entry.hrId), dateFrom, dateTo),
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

  for (const employee of roster) {
    const { hrId, jobTitle } = employee;
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
      // Days outside the employment span (before hire / after exit) are not expected.
      if (!isWithinEmploymentSpan(employee, dateIso)) continue;
      const policy = resolveActiveAttendancePolicy({ hr_id: hrId, job_title: jobTitle }, policyRows, dateIso, dateIso);
      const day = classifyAttendanceDay({ context, dateIso, jobTitle, workingWeekdays: policy?.working_weekdays });
      if (day.isFuture) continue;
      if (day.isHoliday && !day.isWeeklyOff) holidayDays += 1;
      if (!day.isExpectedWorkingDay) continue;
      if (leaveDates.has(dateIso)) {
        leaveDays += 1;
        continue;
      }

      // An approved exception (e.g. field visit / off-site mission) excuses the
      // whole day — whether or not the employee punched. It is neither expected,
      // present, nor absent. Without this, a no-punch day with an approved
      // exception was wrongly counted as an absence (the exceptions feature exists
      // precisely to cover these no-punch days).
      if (exceptionMap.get(`${hrId}|${dateIso}`)?.status === "approved") {
        exceptionDays += 1;
        continue;
      }

      expectedWorkingDays += 1;
      const row = byDate.get(dateIso);
      if (!row) continue;

      presentDays += 1;
      if (row.status === "Late") lateCount += 1;
      if (row.status === "Early leave") earlyLeaveCount += 1;
      if (row.status === "Single punch") singlePunchCount += 1;
      totalDeductionDays += Number(row.deductionDays) || 0;
      totalDeductionValue += Number(row.deductionValue) || 0;
    }

    summaryRows.push({
      absentDays: Math.max(0, expectedWorkingDays - presentDays),
      department: employee.department,
      earlyLeaveCount,
      employeeHrId: hrId,
      employeeName: employee.employeeName,
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
