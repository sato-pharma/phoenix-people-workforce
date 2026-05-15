import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import type {
  LeaveAnalytics,
  LeaveCalendarItem,
  LeaveConflictResult,
  LeaveConflictWarning,
  LeaveRequest,
  PublicHoliday,
  TeamAvailabilityDay,
} from "@/lib/leave/types";
import { getWeekendDaysForEmployee, type TitleWeekendRule } from "./calculations.ts";

const dayMs = 24 * 60 * 60 * 1000;
const pendingStatuses = new Set(["pending_manager", "pending_hr", "manager_approved"]);
const rejectedStatuses = new Set(["manager_rejected", "hr_rejected", "cancelled"]);

function cleanHrId(value: string | null | undefined) {
  return String(value ?? "").trim().toUpperCase();
}

function toUtcDate(value: Date | string) {
  const source = value instanceof Date ? value : new Date(`${value}T00:00:00.000Z`);
  return new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()));
}

function isoDate(value: Date | string) {
  return toUtcDate(value).toISOString().slice(0, 10);
}

function overlaps(startDate: string, endDate: string, rangeStart: string, rangeEnd: string) {
  return startDate <= rangeEnd && endDate >= rangeStart;
}

function eachIsoDate(startDate: string, endDate: string) {
  const dates: string[] = [];
  const start = toUtcDate(startDate);
  const end = toUtcDate(endDate);
  if (end < start) return dates;
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + dayMs)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function holidayEndDate(holiday: PublicHoliday) {
  return holiday.endDate ?? holiday.date;
}

function holidayIncludesDate(holiday: PublicHoliday, date: string) {
  return holiday.date <= date && holidayEndDate(holiday) >= date;
}

function holidayDateSet(holidays: PublicHoliday[]) {
  return new Set(holidays.flatMap((holiday) => eachIsoDate(holiday.date, holidayEndDate(holiday))));
}

function isWorkingDateForEmployee(
  employee: Partial<Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">> | null | undefined,
  date: string,
  publicHolidayDates: Set<string>,
  fallbackWeekendDays: number[] = [5, 6],
  titleWeekendRules: TitleWeekendRule[] = [],
) {
  const weekends = new Set(getWeekendDaysForEmployee(employee, fallbackWeekendDays, titleWeekendRules));
  return !weekends.has(toUtcDate(date).getUTCDay()) && !publicHolidayDates.has(date);
}

function requestIncludesWorkingDate(
  request: LeaveRequest,
  date: string,
  publicHolidayDates: Set<string>,
  fallbackWeekendDays: number[] = [5, 6],
  titleWeekendRules: TitleWeekendRule[] = [],
) {
  return request.startDate <= date && request.endDate >= date && isWorkingDateForEmployee(request.employee, date, publicHolidayDates, fallbackWeekendDays, titleWeekendRules);
}

function requestsOverlapOnWorkingDays(
  request: LeaveRequest,
  input: {
    employee: Partial<Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">> | null | undefined;
    endDate: string;
    startDate: string;
  },
  publicHolidayDates: Set<string>,
  fallbackWeekendDays: number[] = [5, 6],
  titleWeekendRules: TitleWeekendRule[] = [],
) {
  const startDate = request.startDate > input.startDate ? request.startDate : input.startDate;
  const endDate = request.endDate < input.endDate ? request.endDate : input.endDate;
  return eachIsoDate(startDate, endDate).some((date) =>
    isWorkingDateForEmployee(input.employee, date, publicHolidayDates, fallbackWeekendDays, titleWeekendRules) &&
    requestIncludesWorkingDate(request, date, publicHolidayDates, fallbackWeekendDays, titleWeekendRules)
  );
}

function monthKey(value: string) {
  return value.slice(0, 7);
}

function formatMonthKey(value: string) {
  const [year, month] = value.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(month) - 1] ?? month} ${year}`;
}

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function pushCount(map: Map<string, number>, key: string, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedCounts(map: Map<string, number>, limit = 8) {
  return Array.from(map.entries())
    .map(([label, value]) => ({ label, value: Math.round(value * 100) / 100 }))
    .sort((left, right) => right.value - left.value || left.label.localeCompare(right.label))
    .slice(0, limit);
}

export function getLeaveCalendarRange(month: number, year: number) {
  const safeMonth = Math.min(12, Math.max(1, Math.trunc(month)));
  const start = new Date(Date.UTC(year, safeMonth - 1, 1));
  const end = new Date(Date.UTC(year, safeMonth, 0));
  return {
    endDate: end.toISOString().slice(0, 10),
    startDate: start.toISOString().slice(0, 10),
  };
}

export function buildLeaveCalendarItems(
  requests: LeaveRequest[],
  holidays: PublicHoliday[],
  options: { area?: string; employeeHrId?: string; line?: string; month: number; status?: string; year: number },
): LeaveCalendarItem[] {
  const range = getLeaveCalendarRange(options.month, options.year);
  const employeeFilter = cleanHrId(options.employeeHrId);
  const requestItems = requests
    .filter((request) => overlaps(request.startDate, request.endDate, range.startDate, range.endDate))
    .filter((request) => !options.status || request.status === options.status)
    .filter((request) => !employeeFilter || cleanHrId(request.employeeHrId) === employeeFilter)
    .filter((request) => !options.line || request.employee?.lineName === options.line)
    .filter((request) => !options.area || request.employee?.areaName === options.area)
    .map((request): LeaveCalendarItem => ({
      areaName: request.employee?.areaName ?? null,
      employeeHrId: request.employeeHrId,
      employeeName: request.employee?.fullName ?? request.employeeHrId,
      endDate: request.endDate,
      id: request.id,
      kind: "request",
      leaveTypeName: request.leaveType?.name ?? "Leave",
      lineName: request.employee?.lineName ?? null,
      startDate: request.startDate,
      status: request.status,
      title: `${request.employee?.fullName ?? request.employeeHrId} - ${request.leaveType?.name ?? "Leave"}`,
      totalWorkingDays: request.totalWorkingDays,
    }));
  const holidayItems = holidays
    .filter((holiday) => holiday.isActive && overlaps(holiday.date, holidayEndDate(holiday), range.startDate, range.endDate))
    .map((holiday): LeaveCalendarItem => ({
      endDate: holidayEndDate(holiday),
      id: `holiday-${holiday.id}`,
      kind: "holiday",
      startDate: holiday.date,
      status: "public_holiday",
      title: holiday.name,
      totalWorkingDays: 0,
    }));
  return [...requestItems, ...holidayItems].sort((left, right) => left.startDate.localeCompare(right.startDate) || left.title.localeCompare(right.title));
}

export function buildTeamAvailability(
  requests: LeaveRequest[],
  holidays: PublicHoliday[],
  options: { area?: string; employeeHrId?: string; endDate: string; line?: string; startDate: string; titleWeekendRules?: TitleWeekendRule[] },
): TeamAvailabilityDay[] {
  const employeeFilter = cleanHrId(options.employeeHrId);
  const filtered = requests
    .filter((request) => overlaps(request.startDate, request.endDate, options.startDate, options.endDate))
    .filter((request) => !employeeFilter || cleanHrId(request.employeeHrId) === employeeFilter)
    .filter((request) => !options.line || request.employee?.lineName === options.line)
    .filter((request) => !options.area || request.employee?.areaName === options.area);
  const activeHolidays = holidays.filter((holiday) => holiday.isActive && overlaps(holiday.date, holidayEndDate(holiday), options.startDate, options.endDate));
  const publicHolidayDates = holidayDateSet(activeHolidays);

  return eachIsoDate(options.startDate, options.endDate).map((date) => {
    const dayRequests = filtered.filter((request) => requestIncludesWorkingDate(request, date, publicHolidayDates, [5, 6], options.titleWeekendRules ?? []));
    const approved = dayRequests.filter((request) => request.status === "hr_approved");
    const pending = dayRequests.filter((request) => pendingStatuses.has(request.status));
    const rejected = dayRequests.filter((request) => rejectedStatuses.has(request.status));
    const publicHolidays = activeHolidays.filter((holiday) => holidayIncludesDate(holiday, date));
    const activePeople = new Set([...approved, ...pending].map((request) => cleanHrId(request.employeeHrId)));
    return { approved, conflictCount: Math.max(0, activePeople.size - 1), date, pending, publicHolidays, rejected };
  });
}

export function detectLeaveConflicts(
  input: {
    employee: Pick<EmployeeDirectoryRow, "areaName" | "fullName" | "hrId" | "lineName"> & Partial<Pick<EmployeeDirectoryRow, "jobTitle" | "positionTitle">>;
    endDate: string;
    existingRequests: LeaveRequest[];
    startDate: string;
  },
  options: { blockOnConflict?: boolean; publicHolidayDates?: string[]; sameAreaWarningThreshold?: number; sameLineWarningThreshold?: number; titleWeekendRules?: TitleWeekendRule[]; weekendDays?: number[] } = {},
): LeaveConflictResult {
  const sameLineThreshold = options.sameLineWarningThreshold ?? 2;
  const sameAreaThreshold = options.sameAreaWarningThreshold ?? 4;
  const requesterHrId = cleanHrId(input.employee.hrId);
  const publicHolidayDates = new Set(options.publicHolidayDates ?? []);
  const activeRequests = input.existingRequests.filter((request) => request.status === "hr_approved" || pendingStatuses.has(request.status));
  const overlappingRequests = activeRequests.filter((request) =>
    cleanHrId(request.employeeHrId) !== requesterHrId &&
    overlaps(request.startDate, request.endDate, input.startDate, input.endDate) &&
    requestsOverlapOnWorkingDays(request, input, publicHolidayDates, options.weekendDays, options.titleWeekendRules ?? [])
  );
  const sameLinePeople = new Set(
    overlappingRequests
      .filter((request) => request.employee?.lineName && request.employee.lineName === input.employee.lineName)
      .map((request) => cleanHrId(request.employeeHrId)),
  );
  const sameAreaPeople = new Set(
    overlappingRequests
      .filter((request) => request.employee?.areaName && request.employee.areaName === input.employee.areaName)
      .map((request) => cleanHrId(request.employeeHrId)),
  );
  const warnings: LeaveConflictWarning[] = [];

  if (sameLinePeople.size >= sameLineThreshold) {
    warnings.push({
      code: "same_line_capacity",
      count: sameLinePeople.size,
      message: `${sameLinePeople.size} employee${sameLinePeople.size === 1 ? "" : "s"} from ${input.employee.lineName ?? "this line"} already have overlapping leave.`,
      severity: options.blockOnConflict ? "blocker" : "warning",
      threshold: sameLineThreshold,
    });
  }
  if (sameAreaPeople.size >= sameAreaThreshold) {
    warnings.push({
      code: "same_area_capacity",
      count: sameAreaPeople.size,
      message: `${sameAreaPeople.size} employee${sameAreaPeople.size === 1 ? "" : "s"} from ${input.employee.areaName ?? "this area"} already have overlapping leave.`,
      severity: options.blockOnConflict ? "blocker" : "warning",
      threshold: sameAreaThreshold,
    });
  }

  return {
    blocked: Boolean(options.blockOnConflict && warnings.length > 0),
    overlappingRequests,
    sameAreaCount: sameAreaPeople.size,
    sameLineCount: sameLinePeople.size,
    warnings,
  };
}

export function buildLeaveAnalytics(requests: LeaveRequest[], holidays: PublicHoliday[], asOfDate: Date | string = new Date()): LeaveAnalytics {
  const today = isoDate(asOfDate);
  const byStatus = new Map<string, number>();
  const consumptionByMonth = new Map<string, number>();
  const byType = new Map<string, number>();
  const byLine = new Map<string, number>();
  const aging = new Map<string, number>([["0-2 days", 0], ["3-7 days", 0], ["8+ days", 0]]);
  const holidayImpact = new Map<string, number>();

  for (const request of requests) {
    pushCount(byStatus, statusLabel(request.status));
    if (request.status === "hr_approved") {
      pushCount(consumptionByMonth, monthKey(request.startDate), request.totalWorkingDays);
      pushCount(byType, request.leaveType?.name ?? "Leave", request.totalWorkingDays);
      pushCount(byLine, request.employee?.lineName ?? "Unassigned", request.totalWorkingDays);
    }
    if (pendingStatuses.has(request.status)) {
      const ageDays = Math.max(0, Math.floor((toUtcDate(today).getTime() - toUtcDate(request.requestedAt.slice(0, 10)).getTime()) / dayMs));
      if (ageDays <= 2) pushCount(aging, "0-2 days");
      else if (ageDays <= 7) pushCount(aging, "3-7 days");
      else pushCount(aging, "8+ days");
    }
  }
  for (const holiday of holidays.filter((item) => item.isActive)) {
    for (const date of eachIsoDate(holiday.date, holidayEndDate(holiday))) {
      pushCount(holidayImpact, formatMonthKey(monthKey(date)));
    }
  }

  return {
    consumptionByMonth: sortedCounts(consumptionByMonth, 12).map((row) => ({ ...row, label: formatMonthKey(row.label) })).reverse(),
    pendingApprovalAging: Array.from(aging.entries()).map(([label, value]) => ({ label, value })),
    publicHolidayImpact: sortedCounts(holidayImpact, 12),
    requestsByStatus: sortedCounts(byStatus, 12),
    topLeaveTypes: sortedCounts(byType, 6),
    upcomingApprovedLeave: requests
      .filter((request) => request.status === "hr_approved" && request.startDate >= today)
      .sort((left, right) => left.startDate.localeCompare(right.startDate))
      .slice(0, 8),
    usageByLine: sortedCounts(byLine, 8),
  };
}
