import { normalizeHrIdForAccess, type AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

export type PrivateCalendarSource = "attendance" | "excuse" | "holiday" | "plan" | "vacation";
export type PrivateCalendarSeverity = "danger" | "info" | "success" | "warning";
export type PrivateCalendarViewMode = "employee" | "team";

export const privateCalendarSources = ["attendance", "vacation", "excuse", "plan", "holiday"] as const satisfies readonly PrivateCalendarSource[];

export const privateCalendarSourceLabels: Record<PrivateCalendarSource, string> = {
  attendance: "Attendance",
  excuse: "Excuse",
  holiday: "National vacation",
  plan: "Plan",
  vacation: "Vacation",
};

export const defaultPrivateCalendarGlobalHrIds = ["B-10", "admin-HR"] as const;

export type PrivateCalendarEmployeeOption = {
  departmentName: string | null;
  fullName: string;
  hrId: string;
  jobTitle: string | null;
  lineName: string | null;
  managerHrId: string | null;
  managerName: string | null;
};

export type PrivateCalendarItem = {
  approvalImpact: string | null;
  description: string | null;
  detailLines: string[];
  employeeDepartmentName: string | null;
  employeeHrId: string | null;
  employeeJobTitle: string | null;
  employeeLineName: string | null;
  employeeName: string | null;
  endDate: string;
  exceptionFlags: string[];
  id: string;
  managerName: string | null;
  severity: PrivateCalendarSeverity;
  source: PrivateCalendarSource;
  sourceLabel: string;
  sourceRecordId: string | null;
  sourceSystem: string;
  sourceTable: string | null;
  startDate: string;
  status: string | null;
  time: string | null;
  title: string;
};

export type PrivateCalendarException = {
  code: string;
  date: string;
  description: string;
  employeeHrId: string | null;
  employeeName: string | null;
  id: string;
  relatedItemIds: string[];
  severity: Exclude<PrivateCalendarSeverity, "success">;
  title: string;
};

export type PrivateCalendarTeamSummary = PrivateCalendarEmployeeOption & {
  exceptionCount: number;
  itemCount: number;
  sourceCounts: Record<PrivateCalendarSource, number>;
};

export type PrivateCalendarWorkspace = {
  access: {
    canSelectEmployee: boolean;
    isGlobalViewer: boolean;
  };
  exceptions: PrivateCalendarException[];
  items: PrivateCalendarItem[];
  month: number;
  schemaReady: boolean;
  selectedEmployee: PrivateCalendarEmployeeOption;
  sourceReadiness: Record<PrivateCalendarSource, boolean>;
  summary: Record<PrivateCalendarSource, number> & { total: number };
  teamSummary: PrivateCalendarTeamSummary[];
  visibleEmployees: PrivateCalendarEmployeeOption[];
  viewMode: PrivateCalendarViewMode;
  weeks: Array<Array<{ date: string | null; inMonth: boolean }>>;
  year: number;
};

export type PrivateCalendarAttendanceRow = {
  actualFirstPunch: string;
  actualLastPunch: string;
  dateIso: string;
  deductionDays: string;
  earlyLeaveMinutes: string;
  employeeHrId: string;
  employeeName: string;
  hasException?: boolean;
  lateMinutes: string;
  recommendedAction: string;
  scheduledEnd: string;
  scheduledStart: string;
  status: string;
  timeLong: string;
};

export type PrivateCalendarVacationRow = {
  day_part?: string | null;
  duration_days?: number | string | null;
  employee_hr_id: string;
  employee_name?: string | null;
  end_date: string | null;
  id: string;
  notes?: string | null;
  paid_duration_days?: number | string | null;
  payment_status?: string | null;
  start_date: string;
  status: string | null;
  vacation_type?: string | null;
};

export type PrivateCalendarExcuseRow = {
  duration_hours?: number | string | null;
  employee_hr_id: string;
  employee_name?: string | null;
  excuse_date: string;
  excuse_type: string | null;
  id: string;
  manager_decision_comment?: string | null;
  status: string | null;
};

export type PrivateCalendarPlanRow = {
  activity_date: string;
  activity_title: string | null;
  activity_type: string | null;
  area: string | null;
  employee_hr_id: string;
  employee_name: string;
  end_time: string | null;
  id: string;
  location_text: string | null;
  notes: string | null;
  plan_kind: string;
  start_time: string | null;
  status: string;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function nullableText(value: unknown) {
  const text = cleanText(value);
  return text ? text : null;
}

export function privateCalendarHrIdKey(value: string | null | undefined) {
  return normalizeHrIdForAccess(value) ?? "";
}

function hrIdsMatch(left: string | null | undefined, right: string | null | undefined) {
  const a = privateCalendarHrIdKey(left);
  const b = privateCalendarHrIdKey(right);
  return Boolean(a && b && a === b);
}

export function configuredPrivateCalendarGlobalHrIds() {
  const configured = String(process.env.PHOENIX_PRIVATE_CALENDAR_GLOBAL_HR_IDS ?? "")
    .split(",")
    .map((value) => privateCalendarHrIdKey(value))
    .filter(Boolean);
  const defaults = defaultPrivateCalendarGlobalHrIds.map((value) => privateCalendarHrIdKey(value));
  return Array.from(new Set([...defaults, ...configured]));
}

export function isPrivateCalendarGlobalViewer(
  access: AccessContext,
  globalHrIds: readonly string[] = configuredPrivateCalendarGlobalHrIds(),
) {
  if (access.scope === "system" || access.role === "CEO" || access.role === "Super Admin") return true;
  const allowed = new Set(globalHrIds.map((value) => privateCalendarHrIdKey(value)).filter(Boolean));
  return [access.hrId, access.loginId].some((value) => allowed.has(privateCalendarHrIdKey(value)));
}

export function canReadPrivateCalendarEmployee(
  access: AccessContext,
  employee: Pick<EmployeeDirectoryRow, "hrId" | "managerHrId">,
  globalHrIds?: readonly string[],
) {
  if (isPrivateCalendarGlobalViewer(access, globalHrIds)) return true;
  if (hrIdsMatch(access.hrId, employee.hrId) || hrIdsMatch(access.loginId, employee.hrId)) return true;
  return hrIdsMatch(access.hrId, employee.managerHrId) || hrIdsMatch(access.loginId, employee.managerHrId);
}

export function mapPrivateCalendarEmployee(employee: EmployeeDirectoryRow): PrivateCalendarEmployeeOption {
  return {
    departmentName: employee.departmentName,
    fullName: employee.fullName,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle || employee.positionTitle,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    managerName: employee.managerName,
  };
}

export function resolvePrivateCalendarVisibleEmployees(
  access: AccessContext,
  employees: EmployeeDirectoryRow[],
  globalHrIds?: readonly string[],
) {
  return employees
    .filter((employee) => canReadPrivateCalendarEmployee(access, employee, globalHrIds))
    .map(mapPrivateCalendarEmployee)
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

function displayEnum(value: string | null | undefined, fallback = "Other") {
  const text = cleanText(value);
  if (!text) return fallback;
  return text
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function planActivityLabel(activityType: string | null | undefined, activityTitle: string | null | undefined) {
  const type = cleanText(activityType);
  const title = cleanText(activityTitle);
  if (type === "Field") return "Single Visit";
  if (type === "Other" && title.toLowerCase() === "coaching") return "Coaching";
  return title || type || "Plan activity";
}

function planSlotLabel(startTime: string | null | undefined, endTime: string | null | undefined) {
  const start = cleanText(startTime).slice(0, 5);
  const end = cleanText(endTime).slice(0, 5);
  if (start === "09:00" && end === "13:00") return "AM";
  if (start === "13:00" && end === "17:00") return "PM";
  if (start || end) return [start, end].filter(Boolean).join(" - ");
  return "Full day";
}

function attendanceSeverity(status: string, hasException?: boolean): PrivateCalendarSeverity {
  if (hasException || status === "Complete") return "success";
  if (/absence|single punch|late|early|short/i.test(status)) return "warning";
  return "info";
}

function positiveNumber(value: unknown) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) && parsed > 0;
}

function attendanceExceptionFlags(row: PrivateCalendarAttendanceRow) {
  const flags: string[] = [];
  const status = cleanText(row.status);
  const action = cleanText(row.recommendedAction);
  if (/single punch/i.test(status) || (!row.actualLastPunch && row.actualFirstPunch)) flags.push("Single punch");
  if (positiveNumber(row.lateMinutes) || /late/i.test(status)) flags.push("Late arrival");
  if (positiveNumber(row.earlyLeaveMinutes) || /early/i.test(status)) flags.push("Early leave");
  if (/short/i.test(status) || /short/i.test(action)) flags.push("Short day");
  if (/absence|absent/i.test(status)) flags.push("Absence risk");
  if (row.hasException) flags.push("Approved attendance exception");
  return Array.from(new Set(flags));
}

export function mapAttendanceRowToPrivateCalendarItem(row: PrivateCalendarAttendanceRow): PrivateCalendarItem {
  const firstPunch = cleanText(row.actualFirstPunch);
  const lastPunch = cleanText(row.actualLastPunch);
  const time = firstPunch && lastPunch ? `${firstPunch} - ${lastPunch}` : firstPunch || lastPunch || null;
  const detailLines = [
    row.scheduledStart || row.scheduledEnd ? `Schedule: ${[row.scheduledStart, row.scheduledEnd].filter(Boolean).join(" - ")}` : null,
    row.timeLong ? `Working hours: ${row.timeLong}` : null,
    row.lateMinutes ? `Late: ${row.lateMinutes} min` : null,
    row.earlyLeaveMinutes ? `Early leave: ${row.earlyLeaveMinutes} min` : null,
    row.deductionDays ? `Deduction days: ${row.deductionDays}` : null,
    row.recommendedAction ? `Action: ${row.recommendedAction}` : null,
  ].filter((value): value is string => Boolean(value));
  return {
    approvalImpact: null,
    description: row.recommendedAction || null,
    detailLines,
    employeeDepartmentName: null,
    employeeHrId: row.employeeHrId,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: row.employeeName,
    endDate: row.dateIso,
    exceptionFlags: attendanceExceptionFlags(row),
    id: `attendance-${privateCalendarHrIdKey(row.employeeHrId)}-${row.dateIso}`,
    managerName: null,
    severity: attendanceSeverity(row.status, row.hasException),
    source: "attendance",
    sourceLabel: "Imported fingerprint punches",
    sourceRecordId: `${privateCalendarHrIdKey(row.employeeHrId)}-${row.dateIso}`,
    sourceSystem: "Fingerprint attendance",
    sourceTable: "attendance_raw_punches",
    startDate: row.dateIso,
    status: row.status,
    time,
    title: `Attendance - ${row.status || "Recorded"}`,
  };
}

export function mapVacationRowToPrivateCalendarItem(row: PrivateCalendarVacationRow): PrivateCalendarItem {
  const type = displayEnum(row.vacation_type, "Vacation");
  const duration = cleanText(row.duration_days);
  const paid = cleanText(row.paid_duration_days);
  return {
    approvalImpact: "Approved vacation appears on the employee private calendar and explains the covered attendance day.",
    description: nullableText(row.notes),
    detailLines: [
      duration ? `Duration: ${duration} day(s)` : null,
      paid ? `Paid: ${paid} day(s)` : null,
      row.payment_status ? `Payment: ${displayEnum(row.payment_status)}` : null,
      row.day_part ? `Day part: ${displayEnum(row.day_part)}` : null,
    ].filter((value): value is string => Boolean(value)),
    employeeDepartmentName: null,
    employeeHrId: row.employee_hr_id,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: nullableText(row.employee_name),
    endDate: row.end_date || row.start_date,
    exceptionFlags: [],
    id: `vacation-${row.id}`,
    managerName: null,
    severity: "info",
    source: "vacation",
    sourceLabel: "Approved vacation request",
    sourceRecordId: row.id,
    sourceSystem: "Vacation workflow",
    sourceTable: "v2_vacation_requests",
    startDate: row.start_date,
    status: row.status,
    time: row.day_part && row.day_part !== "full_day" ? displayEnum(row.day_part) : "Full day",
    title: `${type} Vacation`,
  };
}

export function mapExcuseRowToPrivateCalendarItem(row: PrivateCalendarExcuseRow): PrivateCalendarItem {
  const excuseType = cleanText(row.excuse_type).toLowerCase() === "afternoon" ? "Afternoon" : "Morning";
  const duration = cleanText(row.duration_hours) || "2";
  return {
    approvalImpact: "Approved excuse appears on the employee private calendar as a 2-hour covered block.",
    description: nullableText(row.manager_decision_comment),
    detailLines: [`Duration: ${duration} hour(s)`],
    employeeDepartmentName: null,
    employeeHrId: row.employee_hr_id,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: nullableText(row.employee_name),
    endDate: row.excuse_date,
    exceptionFlags: [],
    id: `excuse-${row.id}`,
    managerName: null,
    severity: "warning",
    source: "excuse",
    sourceLabel: "Approved excuse request",
    sourceRecordId: row.id,
    sourceSystem: "Excuse workflow",
    sourceTable: "v2_excuse_requests",
    startDate: row.excuse_date,
    status: row.status,
    time: `${excuseType} (${duration}h)`,
    title: `${excuseType} Excuse`,
  };
}

export function mapPlanRowToPrivateCalendarItem(row: PrivateCalendarPlanRow): PrivateCalendarItem {
  const activity = planActivityLabel(row.activity_type, row.activity_title);
  const region = nullableText(row.location_text);
  const area = nullableText(row.area);
  return {
    approvalImpact: "Submitted or approved plan activity appears on the employee private calendar for month clarity.",
    description: nullableText(row.notes),
    detailLines: [
      `Kind: ${displayEnum(row.plan_kind)}`,
      region ? `Region: ${region}` : null,
      area ? `Area: ${area}` : null,
      `Status: ${displayEnum(row.status)}`,
    ].filter((value): value is string => Boolean(value)),
    employeeDepartmentName: null,
    employeeHrId: row.employee_hr_id,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: row.employee_name,
    endDate: row.activity_date,
    exceptionFlags: [],
    id: `plan-${row.id}`,
    managerName: null,
    severity: "info",
    source: "plan",
    sourceLabel: "Weekly / monthly plan item",
    sourceRecordId: row.id,
    sourceSystem: "Planning workflow",
    sourceTable: "employee_plan_items",
    startDate: row.activity_date,
    status: row.status,
    time: planSlotLabel(row.start_time, row.end_time),
    title: area ? `${activity} - ${area}` : activity,
  };
}

export function mapHolidayToPrivateCalendarItem(input: {
  description?: string | null;
  endDate?: string | null;
  id: string;
  name: string;
  startDate: string;
}): PrivateCalendarItem {
  return {
    approvalImpact: null,
    description: input.description ?? null,
    detailLines: [],
    employeeDepartmentName: null,
    employeeHrId: null,
    employeeJobTitle: null,
    employeeLineName: null,
    employeeName: null,
    endDate: input.endDate || input.startDate,
    exceptionFlags: [],
    id: `holiday-${input.id}`,
    managerName: null,
    severity: "success",
    source: "holiday",
    sourceLabel: "Configured national vacation",
    sourceRecordId: input.id,
    sourceSystem: "Holiday calendar",
    sourceTable: null,
    startDate: input.startDate,
    status: "holiday",
    time: "Full day",
    title: input.name,
  };
}

export function privateCalendarItemOccursOn(item: PrivateCalendarItem, date: string) {
  return date >= item.startDate && date <= item.endDate;
}

export function summarizePrivateCalendarItems(items: PrivateCalendarItem[]): PrivateCalendarWorkspace["summary"] {
  const summary = {
    attendance: 0,
    excuse: 0,
    holiday: 0,
    plan: 0,
    total: items.length,
    vacation: 0,
  };
  for (const item of items) {
    summary[item.source] += 1;
  }
  return summary;
}

function sourceCounts() {
  return {
    attendance: 0,
    excuse: 0,
    holiday: 0,
    plan: 0,
    vacation: 0,
  } satisfies Record<PrivateCalendarSource, number>;
}

export function buildPrivateCalendarTeamSummary(input: {
  employees: PrivateCalendarEmployeeOption[];
  exceptions: PrivateCalendarException[];
  items: PrivateCalendarItem[];
}) {
  return input.employees.map((employee) => {
    const employeeKey = privateCalendarHrIdKey(employee.hrId);
    const counts = sourceCounts();
    let itemCount = 0;
    for (const item of input.items) {
      if (item.employeeHrId && privateCalendarHrIdKey(item.employeeHrId) !== employeeKey) continue;
      if (!item.employeeHrId && item.source !== "holiday") continue;
      counts[item.source] += 1;
      itemCount += 1;
    }
    return {
      ...employee,
      exceptionCount: input.exceptions.filter((exception) => privateCalendarHrIdKey(exception.employeeHrId) === employeeKey).length,
      itemCount,
      sourceCounts: counts,
    };
  });
}

function eachDate(start: string, end: string) {
  const dates: string[] = [];
  const current = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (current <= last) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function isRegularWorkday(date: string) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 5 && day !== 6;
}

function createException(input: Omit<PrivateCalendarException, "id">) {
  return {
    ...input,
    id: [
      "private-calendar-exception",
      input.code,
      privateCalendarHrIdKey(input.employeeHrId) || "company",
      input.date,
      input.relatedItemIds.join("-"),
    ].join("-"),
  };
}

export function derivePrivateCalendarExceptions(input: {
  employees: PrivateCalendarEmployeeOption[];
  end: string;
  items: PrivateCalendarItem[];
  start: string;
  today?: string;
}) {
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const dates = eachDate(input.start, input.end).filter((date) => date <= today);
  const exceptions: PrivateCalendarException[] = [];
  const itemsByEmployeeDate = new Map<string, PrivateCalendarItem[]>();
  const companyItemsByDate = new Map<string, PrivateCalendarItem[]>();

  for (const item of input.items) {
    for (const date of dates) {
      if (!privateCalendarItemOccursOn(item, date)) continue;
      if (!item.employeeHrId) {
        companyItemsByDate.set(date, [...(companyItemsByDate.get(date) ?? []), item]);
        continue;
      }
      const key = `${privateCalendarHrIdKey(item.employeeHrId)}|${date}`;
      itemsByEmployeeDate.set(key, [...(itemsByEmployeeDate.get(key) ?? []), item]);
    }
  }

  for (const employee of input.employees) {
    const employeeKey = privateCalendarHrIdKey(employee.hrId);
    for (const date of dates) {
      const dayItems = itemsByEmployeeDate.get(`${employeeKey}|${date}`) ?? [];
      const companyItems = companyItemsByDate.get(date) ?? [];
      const attendance = dayItems.filter((item) => item.source === "attendance");
      const vacations = dayItems.filter((item) => item.source === "vacation");
      const excuses = dayItems.filter((item) => item.source === "excuse");
      const plans = dayItems.filter((item) => item.source === "plan");
      const holidays = companyItems.filter((item) => item.source === "holiday");

      for (const item of attendance) {
        for (const flag of item.exceptionFlags) {
          if (flag === "Approved attendance exception") continue;
          exceptions.push(createException({
            code: flag.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""),
            date,
            description: `${item.employeeName ?? employee.fullName}: ${flag} detected from fingerprint attendance.`,
            employeeHrId: employee.hrId,
            employeeName: employee.fullName,
            relatedItemIds: [item.id],
            severity: flag === "Absence risk" ? "danger" : "warning",
            title: flag,
          }));
        }
      }

      if (attendance.length > 0 && vacations.length > 0) {
        exceptions.push(createException({
          code: "attendance_during_vacation",
          date,
          description: `${employee.fullName} has fingerprint attendance while an approved vacation covers the same date.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: [...attendance, ...vacations].map((item) => item.id),
          severity: "warning",
          title: "Attendance during vacation",
        }));
      }

      if (plans.length > 0 && attendance.length === 0 && vacations.length === 0 && holidays.length === 0) {
        exceptions.push(createException({
          code: "planned_day_without_attendance",
          date,
          description: `${employee.fullName} has a plan item but no fingerprint attendance for this date.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: plans.map((item) => item.id),
          severity: "warning",
          title: "Plan without attendance",
        }));
      }

      if (
        isRegularWorkday(date) &&
        attendance.length === 0 &&
        vacations.length === 0 &&
        excuses.length === 0 &&
        holidays.length === 0
      ) {
        exceptions.push(createException({
          code: "missing_attendance_cover",
          date,
          description: `${employee.fullName} has no fingerprint attendance, approved vacation, approved excuse, or national vacation covering this workday.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: [],
          severity: "danger",
          title: "Missing attendance cover",
        }));
      }
    }
  }

  return exceptions.sort((left, right) => `${left.date}-${left.employeeName}-${left.title}`.localeCompare(`${right.date}-${right.employeeName}-${right.title}`));
}
