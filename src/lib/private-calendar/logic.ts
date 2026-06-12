import { normalizeHrIdForAccess, type AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";

export type PrivateCalendarSource = "attendance" | "excuse" | "holiday" | "plan" | "vacation";
export type PrivateCalendarSeverity = "danger" | "info" | "success" | "warning";

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
  description: string | null;
  detailLines: string[];
  employeeHrId: string | null;
  employeeName: string | null;
  endDate: string;
  id: string;
  severity: PrivateCalendarSeverity;
  source: PrivateCalendarSource;
  startDate: string;
  status: string | null;
  time: string | null;
  title: string;
};

export type PrivateCalendarWorkspace = {
  access: {
    canSelectEmployee: boolean;
    isGlobalViewer: boolean;
  };
  items: PrivateCalendarItem[];
  month: number;
  schemaReady: boolean;
  selectedEmployee: PrivateCalendarEmployeeOption;
  sourceReadiness: Record<PrivateCalendarSource, boolean>;
  summary: Record<PrivateCalendarSource, number> & { total: number };
  visibleEmployees: PrivateCalendarEmployeeOption[];
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
    description: row.recommendedAction || null,
    detailLines,
    employeeHrId: row.employeeHrId,
    employeeName: row.employeeName,
    endDate: row.dateIso,
    id: `attendance-${privateCalendarHrIdKey(row.employeeHrId)}-${row.dateIso}`,
    severity: attendanceSeverity(row.status, row.hasException),
    source: "attendance",
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
    description: nullableText(row.notes),
    detailLines: [
      duration ? `Duration: ${duration} day(s)` : null,
      paid ? `Paid: ${paid} day(s)` : null,
      row.payment_status ? `Payment: ${displayEnum(row.payment_status)}` : null,
      row.day_part ? `Day part: ${displayEnum(row.day_part)}` : null,
    ].filter((value): value is string => Boolean(value)),
    employeeHrId: row.employee_hr_id,
    employeeName: nullableText(row.employee_name),
    endDate: row.end_date || row.start_date,
    id: `vacation-${row.id}`,
    severity: "info",
    source: "vacation",
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
    description: nullableText(row.manager_decision_comment),
    detailLines: [`Duration: ${duration} hour(s)`],
    employeeHrId: row.employee_hr_id,
    employeeName: nullableText(row.employee_name),
    endDate: row.excuse_date,
    id: `excuse-${row.id}`,
    severity: "warning",
    source: "excuse",
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
    description: nullableText(row.notes),
    detailLines: [
      `Kind: ${displayEnum(row.plan_kind)}`,
      region ? `Region: ${region}` : null,
      area ? `Area: ${area}` : null,
      `Status: ${displayEnum(row.status)}`,
    ].filter((value): value is string => Boolean(value)),
    employeeHrId: row.employee_hr_id,
    employeeName: row.employee_name,
    endDate: row.activity_date,
    id: `plan-${row.id}`,
    severity: "info",
    source: "plan",
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
    description: input.description ?? null,
    detailLines: [],
    employeeHrId: null,
    employeeName: null,
    endDate: input.endDate || input.startDate,
    id: `holiday-${input.id}`,
    severity: "success",
    source: "holiday",
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
