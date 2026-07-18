/**
 * Head Office attendance calendar for the admin Field Workforce Compliance workspace.
 *
 * Office-based staff don't generate meaningful CRM field visits, so the visit-driven Team
 * Calendar tells you little about their real attendance. This is a parallel, additive calendar
 * built from the physical fingerprint attendance system instead: any active employee enrolled
 * on a fingerprint device (device-mapped) gets a monthly row of office-day statuses — the same
 * population isAttendanceTracked()'s device-mapping signal already covers (HR, Finance,
 * Marketing, NSMs, Product/Training managers, admins, …), regardless of whether their title is
 * ALSO field-visit-eligible. A National Sales Manager or Product Manager who rides along on
 * visits still primarily works from the office, so they intentionally appear in both this tab
 * (office presence) and the visit calendar (field activity) — two complementary signals about
 * the same person, not a duplication to resolve. Deliberately does not touch
 * FieldWorkforceCellStatus or the visit-compliance pipeline — this is a different question (did
 * they physically attend the office) answered from a disjoint data source.
 */

import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { loadEmployeeDayPunchMinutes, type EmployeeDayPunches } from "@/lib/attendance/punch-minutes";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import {
  buildAttendanceCalendarContext,
  classifyAttendanceDay,
  getApprovedLeaveDayMap,
  listIsoDatesInRange,
} from "@/lib/attendance/working-days";

export type HeadOfficeDayStatus = "present" | "missing" | "exception" | "weekly_off" | "holiday" | "blank";

export type HeadOfficeDayCell = {
  dateIso: string;
  dayNumber: number;
  firstPunchTime: string | null;
  holidayName: string | null;
  lastPunchTime: string | null;
  status: HeadOfficeDayStatus;
};

export type HeadOfficeEmployeeAttendance = {
  departmentName: string | null;
  employeeName: string;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  missingDays: number;
  presentDays: number;
  timeline: HeadOfficeDayCell[];
};

export type HeadOfficeAttendanceCalendarResult = {
  employeeCount: number;
  employees: HeadOfficeEmployeeAttendance[];
  month: number;
  year: number;
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
 * The Head Office attendance calendar for one month: every active, device-mapped employee
 * who isn't already covered by the field-visit Team Calendar, with a per-day office-attendance
 * status built from fingerprint punches, approved leave/exceptions, holidays, and each
 * employee's own weekly-off schedule.
 */
export async function getHeadOfficeAttendanceCalendar(input: {
  month: number;
  year: number;
}): Promise<HeadOfficeAttendanceCalendarResult> {
  const { month, year } = input;
  const dateFromIso = `${year}-${pad2(month)}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dateToIso = `${year}-${pad2(month)}-${pad2(lastDay)}`;
  const dateIsos = listIsoDatesInRange(dateFromIso, dateToIso);

  const [directory, rawDeviceMappedHrIds] = await Promise.all([
    getEmployeeDirectoryRows(),
    loadActiveDeviceMappedHrIds(),
  ]);
  // loadActiveDeviceMappedHrIds normalizes via normalizeAttendanceHrId (the attendance
  // domain's own normalizer), which is not guaranteed to match canonicalHrIdKey's output
  // format — re-canonicalize before comparing, the same pattern attendance-cross-check.ts
  // uses. Without this, the lookup below silently matches nothing.
  const deviceMappedHrIds = new Set(
    [...rawDeviceMappedHrIds].map((id) => canonicalHrIdKey(id)).filter((key): key is string => Boolean(key)),
  );

  const headOfficeEmployees = directory.filter((employee) => {
    const key = canonicalHrIdKey(employee.hrId);
    return Boolean(key && deviceMappedHrIds.has(key));
  });

  if (headOfficeEmployees.length === 0) {
    return { employeeCount: 0, employees: [], month, year };
  }

  const employeeHrIds = headOfficeEmployees.map((employee) => employee.hrId);
  const [context, rawPunchMinutesByHrId, rawApprovedLeaveByHrId, approvedExceptions] = await Promise.all([
    buildAttendanceCalendarContext({ dateFromIso, dateToIso }),
    loadEmployeeDayPunchMinutes({ dateFromIso, dateToIso, employeeHrIds }),
    getApprovedLeaveDayMap({ dateFromIso, dateToIso, employeeHrIds }),
    getAttendanceExceptions({ dateFrom: dateFromIso, dateTo: dateToIso, status: "approved" }),
  ]);

  // Both maps above are keyed by normalizeAttendanceHrId (the attendance domain's own
  // normalizer), same gap as loadActiveDeviceMappedHrIds above — re-key through
  // canonicalHrIdKey so lookups below (keyed off the employee directory) actually hit.
  const punchMinutesByHrKey = new Map<string, Map<string, EmployeeDayPunches>>();
  for (const [hrId, byDate] of rawPunchMinutesByHrId) {
    const key = canonicalHrIdKey(hrId);
    if (key) punchMinutesByHrKey.set(key, byDate);
  }
  const approvedLeaveByHrKey = new Map<string, Set<string>>();
  for (const [hrId, dates] of rawApprovedLeaveByHrId) {
    const key = canonicalHrIdKey(hrId);
    if (key) approvedLeaveByHrKey.set(key, dates);
  }

  const exceptionDatesByHrKey = new Map<string, Set<string>>();
  for (const exception of approvedExceptions) {
    const key = canonicalHrIdKey(exception.employeeHrId);
    if (!key) continue;
    const dates = exceptionDatesByHrKey.get(key) ?? new Set<string>();
    dates.add(exception.exceptionDate.slice(0, 10));
    exceptionDatesByHrKey.set(key, dates);
  }

  const employees: HeadOfficeEmployeeAttendance[] = headOfficeEmployees.map((employee) => {
    const key = canonicalHrIdKey(employee.hrId) ?? "";
    const punchesByDate = punchMinutesByHrKey.get(key);
    const leaveDates = approvedLeaveByHrKey.get(key);
    const exceptionDates = exceptionDatesByHrKey.get(key);

    let presentDays = 0;
    let missingDays = 0;

    const timeline: HeadOfficeDayCell[] = dateIsos.map((dateIso) => {
      const classification = classifyAttendanceDay({ context, dateIso, jobTitle: employee.jobTitle });
      const punches = punchesByDate?.get(dateIso) ?? null;
      const hasPunch = (punches?.visiblePunchCount ?? 0) > 0;
      const isExcused = Boolean(leaveDates?.has(dateIso) || exceptionDates?.has(dateIso));

      let status: HeadOfficeDayStatus;
      if (classification.isFuture) status = "blank";
      else if (classification.isHoliday) status = "holiday";
      else if (classification.isWeeklyOff) status = "weekly_off";
      else if (hasPunch) status = "present";
      else if (isExcused) status = "exception";
      else status = "missing";

      if (status === "present") presentDays += 1;
      if (status === "missing") missingDays += 1;

      return {
        dateIso,
        dayNumber: Number(dateIso.slice(8, 10)),
        firstPunchTime: minutesToClock(punches?.firstPunchMinutes),
        holidayName: classification.holidayName,
        lastPunchTime: minutesToClock(punches?.lastPunchMinutes),
        status,
      };
    });

    return {
      departmentName: employee.departmentName ?? null,
      employeeName: employee.displayName,
      hrId: employee.hrId,
      jobTitle: employee.jobTitle ?? null,
      lineName: employee.lineName ?? null,
      missingDays,
      presentDays,
      timeline,
    };
  });

  employees.sort((left, right) => left.employeeName.localeCompare(right.employeeName, undefined, { numeric: true }));

  return { employeeCount: employees.length, employees, month, year };
}
