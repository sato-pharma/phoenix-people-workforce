/**
 * Company Activity Report — the single entry point. Takes an ALREADY-FILTERED employee list (the
 * caller runs filterCompanyActivityEmployees first — it needs the full roster for the filter
 * dropdowns anyway, so refetching/refiltering here would just repeat that work) and a free date
 * range, and returns the full day-by-day + summary envelope.
 *
 * Every data source is fetched ONCE across the whole filtered roster + range (never per employee),
 * mirroring the batch-capable-loader convention this codebase already uses everywhere else.
 */

import { buildAttendanceCalendarContext, classifyAttendanceDay, listIsoDatesInRange } from "@/lib/attendance/working-days";
import { loadEmployeeDayPunchMinutes } from "@/lib/attendance/punch-minutes";
import { getCompanyWideOutageDates } from "@/lib/attendance/ingestion-health";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadCompanyActivityChannels } from "@/lib/company-activity-report/channels";
import { loadCompanyActivityCrmDetail } from "@/lib/company-activity-report/crm-detail";
import { loadCompanyActivityLeaveDetail } from "@/lib/company-activity-report/leave-detail";
import { reconcileCompanyActivityDay } from "@/lib/company-activity-report/reconcile";
import { summarizeCompanyActivityEmployee } from "@/lib/company-activity-report/summary";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type { CompanyActivityDayRow, CompanyActivityEmployeeSummary, CompanyActivityReport } from "@/lib/company-activity-report/types";

/**
 * True when `dateIso` falls strictly after a TERMINAL employee's own lastWorkingDate — the
 * per-day boundary reconcile.ts needs to give such a day its own "after_exit" classification
 * instead of judging a person who no longer works here on whether they punched in that day.
 *
 * filterCompanyActivityEmployees (filters.ts) already drops a terminal employee from the roster
 * entirely when their lastWorkingDate falls before the report's startDate — but that only bounds
 * roster INCLUSION. An employee who exits PARTWAY through an already-included range still reaches
 * this per-day loop for every date in range, including the days after they left, so that boundary
 * has to be re-checked here at day granularity too.
 *
 * Exported as a pure function (no lookups, no I/O) so this exact boundary is directly unit
 * testable without standing up the full per-employee data-loading pipeline below.
 */
export function isDayAfterEmployeeExit(
  employee: Pick<EmployeeDirectoryRow, "employmentStatus" | "lastWorkingDate">,
  dateIso: string,
): boolean {
  return (
    isTerminalEmploymentStatus(employee.employmentStatus) &&
    employee.lastWorkingDate != null &&
    dateIso > employee.lastWorkingDate
  );
}

export async function getCompanyActivityReport(input: {
  employees: EmployeeDirectoryRow[];
  startDate: string;
  endDate: string;
}): Promise<CompanyActivityReport> {
  const { employees, startDate, endDate } = input;
  const dates = listIsoDatesInRange(startDate, endDate);

  if (employees.length === 0 || dates.length === 0) {
    return { startDate, endDate, summaries: [], days: [], unmappedCrmVisitCount: null };
  }

  const employeeHrIds = employees.map((employee) => employee.hrId);

  const [calendarContext, punchMap, outageDates, channels, crmResult, leaveMap] = await Promise.all([
    buildAttendanceCalendarContext({ dateFromIso: startDate, dateToIso: endDate }),
    loadEmployeeDayPunchMinutes({ dateFromIso: startDate, dateToIso: endDate, employeeHrIds }),
    getCompanyWideOutageDates(startDate, endDate),
    loadCompanyActivityChannels(),
    loadCompanyActivityCrmDetail({ employeeHrIds, dateFromIso: startDate, dateToIso: endDate }),
    loadCompanyActivityLeaveDetail({ dateFromIso: startDate, dateToIso: endDate }),
  ]);

  const allDays: CompanyActivityDayRow[] = [];
  const summaries: CompanyActivityEmployeeSummary[] = [];

  for (const employee of employees) {
    const attendanceKey = normalizeAttendanceHrId(employee.hrId);
    const leaveKey = canonicalHrIdKey(employee.hrId);
    const employeeDayPunches = attendanceKey ? punchMap.get(attendanceKey) : undefined;
    const employeeCrmDays = attendanceKey ? crmResult.byEmployeeDay.get(attendanceKey) : undefined;
    const employeeLeaveDays = leaveKey ? leaveMap.get(leaveKey) : undefined;
    const hasAttendanceChannel = channels.hasAttendanceChannel(employee.hrId);
    const hasCrmChannel = channels.hasCrmChannel(employee.hrId);

    const employeeDays: CompanyActivityDayRow[] = dates.map((dateIso) => {
      const classification = classifyAttendanceDay({ context: calendarContext, dateIso, jobTitle: employee.jobTitle });
      return reconcileCompanyActivityDay({
        employeeHrId: employee.hrId,
        dateIso,
        classification,
        punches: employeeDayPunches?.get(dateIso),
        crmDay: employeeCrmDays?.get(dateIso),
        leave: employeeLeaveDays?.get(dateIso),
        hasOutage: outageDates.has(dateIso),
        hasAttendanceChannel,
        hasCrmChannel,
        isAfterExit: isDayAfterEmployeeExit(employee, dateIso),
      });
    });

    allDays.push(...employeeDays);
    summaries.push(summarizeCompanyActivityEmployee(employee, employeeDays, { hasAttendanceChannel, hasCrmChannel }));
  }

  summaries.sort((left, right) => left.employeeName.localeCompare(right.employeeName, undefined, { sensitivity: "base" }));

  return {
    startDate,
    endDate,
    summaries,
    days: allDays,
    unmappedCrmVisitCount: crmResult.unmappedCrmVisitCount,
  };
}
