import { getAttendanceExceptionMap } from "@/lib/attendance/exceptions";
import { getFingerprintAttendanceReport, type FingerprintReportRow } from "@/lib/attendance/fingerprint-report";
import { getCompanyWideOutageDates } from "@/lib/attendance/ingestion-health";
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
  /** Working days on which NO punch data exists company-wide — an ingestion outage, not absence.
   * Excluded from both expectedWorkingDays and absentDays. See {@link getMonthlyAttendanceSummary}. */
  noDataDays: number;
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
  /** Working days in this window with zero punches company-wide (ascending). Non-empty means the
   * attendance agent stopped delivering and the month is INCOMPLETE — surface it, never let the
   * absence figures read as final. */
  missingDataDates: string[];
  month: string;
  rows: MonthlyAttendanceSummaryRow[];
  totals: {
    absenceRate: number;
    absentDays: number;
    employees: number;
    expectedWorkingDays: number;
    lateCount: number;
    noDataDays: number;
    presentDays: number;
    totalDeductionDays: number;
  };
};

// Moved to ./monthly-summary-note.ts (a dependency-free module) so the Monthly Attendance Summary
// client component can import the note without pulling this file's server-only chain into its
// bundle; re-exported here for existing server callers (e.g. monthly-summary-export.ts).
export { attendanceMonthlyCycleNote } from "./monthly-summary-note";

/** What one EXPECTED working day contributes to the rollup. */
export type WorkingDayAttendanceOutcome = "absent" | "no_data" | "present";

/**
 * The single decision this report got wrong, isolated so it can be tested without a database.
 *
 * "No punch row" has two completely different causes and only one of them is absence:
 *   - the attendance device delivered data that day and this person is not in it -> absent;
 *   - the device delivered NOTHING for anyone that day -> unmeasurable, and calling it absence
 *     invents evidence against every rostered employee at once.
 * The August 2026 incident is the second case: ingestion stopped on 2026-07-30 and the report
 * asserted a 100% absence rate over roughly 48 days nobody was measured on. An unmeasurable day is
 * excluded from BOTH expectedWorkingDays and absentDays, so the absence rate keeps its meaning over
 * the days actually observed, and is surfaced separately instead of silently disappearing.
 */
export function resolveWorkingDayAttendance(input: {
  hasOutage: boolean;
  hasPunchRow: boolean;
}): WorkingDayAttendanceOutcome {
  if (input.hasOutage) return "no_data";
  return input.hasPunchRow ? "present" : "absent";
}

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
    noDataDays: 0,
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
      missingDataDates: [],
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

  // INGESTION-GAP DETECTION — the difference between "nobody came to work" and "no data arrived".
  //
  // A working day on which not one person in the whole company punched is never a real company-wide
  // absence; it is the on-prem attendance agent having stopped POSTing to
  // /api/attendance/raw-punches. Before this guard such a day was silently counted as an absence
  // for every rostered employee: the agent stopped delivering on 2026-07-30 and the August summary
  // consequently reported a 100% absence rate and ~48 absence-days that never happened, with
  // nothing on screen suggesting anything was wrong. This report's Absent column is read as
  // evidence about people, so "this day has no data" is the only honest answer.
  //
  // Reuses getCompanyWideOutageDates — the SAME detector the weekly-digest fail-safe already uses
  // (digest-reconcile.ts) — rather than re-deriving the rule here, so the digest and this report can
  // never disagree about which days were an outage. It reads attendance_raw_punches directly and
  // already restricts itself to expected working days.
  //
  // Deliberately conservative in one direction: a genuine company-wide holiday the calendar doesn't
  // know about also lands here rather than in absence. Under-reporting absence is recoverable;
  // fabricating it is not.
  const [report, context, leaveMap, policyRows, exceptionMap, outageDates] = await Promise.all([
    // Intentionally unscoped: only rows for hrIds present in the (already-scoped)
    // `roster` are ever read out of this report below, and monthly-summary never
    // reads `report.policyDetails`. Do not add employeeHrIds here — it would be
    // redundant and this call feeds other unscoped internal aggregation elsewhere.
    getFingerprintAttendanceReport({ dateFrom, dateTo }),
    buildAttendanceCalendarContext({ dateFromIso: dateFrom, dateToIso: dateTo }),
    getApprovedLeaveDayMap({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds: roster.map((entry) => entry.hrId) }),
    loadAttendancePolicyGroups({ activeOnly: true }),
    getAttendanceExceptionMap(roster.map((entry) => entry.hrId), dateFrom, dateTo),
    getCompanyWideOutageDates(dateFrom, dateTo),
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
  const missingDataDates = new Set<string>();
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
    let noDataDays = 0;
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

      const row = byDate.get(dateIso);
      // See resolveWorkingDayAttendance: a day nobody was measured on is neither expected nor
      // absent, and is reported separately so the gap stays visible.
      const outcome = resolveWorkingDayAttendance({
        hasOutage: outageDates.has(dateIso),
        hasPunchRow: Boolean(row),
      });
      if (outcome === "no_data") {
        noDataDays += 1;
        missingDataDates.add(dateIso);
        continue;
      }

      expectedWorkingDays += 1;
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
      noDataDays,
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
    acc.noDataDays += row.noDataDays;
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
    missingDataDates: Array.from(missingDataDates).sort(),
    month,
    rows: summaryRows,
    totals,
  };
}
