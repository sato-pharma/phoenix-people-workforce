import { normalizeHrIdForAccess } from "@/lib/hr-id";
import type { AccessContext } from "@/lib/auth/permissions";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { isAttendanceScheduledWorkingDay } from "@/lib/attendance/work-schedule";

export type PrivateCalendarSource = "attendance" | "double_visit" | "excuse" | "holiday" | "vacation";
export type PrivateCalendarSeverity = "danger" | "info" | "success" | "warning";
export type PrivateCalendarViewMode = "employee" | "team";

export const privateCalendarSources = ["attendance", "vacation", "excuse", "holiday", "double_visit"] as const satisfies readonly PrivateCalendarSource[];

export const privateCalendarSourceLabels: Record<PrivateCalendarSource, string> = {
  attendance: "Attendance",
  double_visit: "Double Visit",
  excuse: "Excuse",
  holiday: "National vacation",
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

export type PrivateCalendarReportDetails = {
  checkIn: string | null;
  checkOut: string | null;
  scheduledTime: string | null;
  workingHours: string | null;
};

export type PrivateCalendarItem = {
  approvalImpact: string | null;
  // Short, stacked lines for the cramped month-grid day-cell chip (e.g. ["DV with
  // Omar", "4 AM / 8 PM visits", "Nasr City"]). Falls back to `title` on a single
  // line when absent — only double-visit and attendance items set this today.
  chipLines?: string[];
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
  reportDetails?: PrivateCalendarReportDetails | null;
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
  // Set when an approved Am/Pm-Only vacation covered the other half of this
  // day — a "Complete" status here means the (halved) required presence was
  // met, not that the employee worked a full day.
  halfDayVacationPart?: "am_only" | "pm_only";
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
    fullName: employee.displayName,
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

// "Complete" reads as "Full day" (an office-hours label the employee recognizes);
// every other status keeps its own wording (Late, Short day, Single punch, ...).
// EXCEPT when an approved half-day vacation covered the other half of the shift —
// that "Complete" was judged against a halved requirement, so it must read "Half
// day" (a normal half working day, the other half being a normal half-day
// vacation), never "Full day" — the employee did not work the full day.
function attendanceStatusLabel(status: string, halfDayVacationPart?: "am_only" | "pm_only") {
  if (status === "Complete" && halfDayVacationPart) return "Half day";
  return status === "Complete" ? "Full day" : status || "Recorded";
}

function attendanceTitle(status: string, checkIn: string | null, checkOut: string | null, halfDayVacationPart?: "am_only" | "pm_only") {
  const statusLabel = attendanceStatusLabel(status, halfDayVacationPart);
  if (checkIn && checkOut) return `Office ${checkIn} to ${checkOut} - ${statusLabel}`;
  if (checkIn) return `Office from ${checkIn} - ${statusLabel}`;
  return `Attendance - ${statusLabel}`;
}

// Stacked chip lines for the month-grid day cell: Office / From ** / To ** / Full day.
function attendanceChipLines(status: string, checkIn: string | null, checkOut: string | null, halfDayVacationPart?: "am_only" | "pm_only") {
  const statusLabel = attendanceStatusLabel(status, halfDayVacationPart);
  if (checkIn && checkOut) return ["Office", `From ${checkIn}`, `To ${checkOut}`, statusLabel];
  if (checkIn) return ["Office", `From ${checkIn}`, statusLabel];
  return ["Attendance", statusLabel];
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
  const scheduledStart = cleanText(row.scheduledStart);
  const scheduledEnd = cleanText(row.scheduledEnd);
  const scheduledTime = scheduledStart || scheduledEnd ? [scheduledStart, scheduledEnd].filter(Boolean).join(" - ") : null;
  const workingHours = nullableText(row.timeLong);
  const time = firstPunch && lastPunch ? `${firstPunch} - ${lastPunch}` : firstPunch || lastPunch || null;
  const detailLines = [
    scheduledTime ? `Schedule: ${scheduledTime}` : null,
    workingHours ? `Working hours: ${workingHours}` : null,
    row.lateMinutes ? `Late: ${row.lateMinutes} min` : null,
    row.earlyLeaveMinutes ? `Early leave: ${row.earlyLeaveMinutes} min` : null,
    row.deductionDays ? `Deduction days: ${row.deductionDays}` : null,
    row.recommendedAction ? `Action: ${row.recommendedAction}` : null,
  ].filter((value): value is string => Boolean(value));
  return {
    approvalImpact: null,
    chipLines: attendanceChipLines(row.status, firstPunch || null, lastPunch || null, row.halfDayVacationPart),
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
    reportDetails: {
      checkIn: firstPunch || null,
      checkOut: lastPunch || null,
      scheduledTime,
      workingHours,
    },
    severity: attendanceSeverity(row.status, row.hasException),
    source: "attendance",
    sourceLabel: "Imported fingerprint punches",
    sourceRecordId: `${privateCalendarHrIdKey(row.employeeHrId)}-${row.dateIso}`,
    sourceSystem: "Fingerprint attendance",
    sourceTable: "attendance_raw_punches",
    startDate: row.dateIso,
    status: row.status,
    time,
    title: attendanceTitle(row.status, firstPunch || null, lastPunch || null, row.halfDayVacationPart),
  };
}

export function mapVacationRowToPrivateCalendarItem(
  row: PrivateCalendarVacationRow,
  options?: { pending?: boolean },
): PrivateCalendarItem {
  const type = displayEnum(row.vacation_type, "Vacation");
  const duration = cleanText(row.duration_days);
  const paid = cleanText(row.paid_duration_days);
  const pending = Boolean(options?.pending);
  return {
    approvalImpact: pending
      ? "A pending vacation request reserves the day on the private calendar until the manager approves or rejects it."
      : "Approved vacation appears on the employee private calendar and explains the covered attendance day.",
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
    severity: pending ? "warning" : "info",
    source: "vacation",
    sourceLabel: pending ? "Vacation request (pending approval)" : "Approved vacation request",
    sourceRecordId: row.id,
    sourceSystem: "Vacation workflow",
    sourceTable: "v2_vacation_requests",
    startDate: row.start_date,
    status: row.status,
    time: row.day_part && row.day_part !== "full_day" ? displayEnum(row.day_part) : "Full day",
    title: pending ? `${type} Vacation (pending)` : `${type} Vacation`,
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
    double_visit: 0,
    excuse: 0,
    holiday: 0,
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
    double_visit: 0,
    excuse: 0,
    holiday: 0,
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

function todayInCairo() {
  // Africa/Cairo local calendar date (the app's operating timezone). Using UTC
  // here would slip the "up to today" cutoff a day for a few hours after local
  // midnight and mis-flag the current day near month boundaries.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function derivePrivateCalendarExceptions(input: {
  employees: PrivateCalendarEmployeeOption[];
  end: string;
  isExpectedWorkday?: (employee: PrivateCalendarEmployeeOption, date: string) => boolean;
  items: PrivateCalendarItem[];
  start: string;
  today?: string;
}) {
  const today = input.today ?? todayInCairo();
  const isExpectedWorkday = input.isExpectedWorkday ?? ((employee, date) => isAttendanceScheduledWorkingDay({
    dateIso: date,
    jobTitle: employee.jobTitle,
  }));
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
      const doubleVisits = dayItems.filter((item) => item.source === "double_visit");
      const holidays = companyItems.filter((item) => item.source === "holiday");
      // A CRM Double Visit self-proves attendance for the day — no fingerprint
      // needed. Planned/intended activity (the Planning Calendar) is never
      // consulted here — only actually recorded/verified sources count as covered.
      const isCovered =
        attendance.length > 0 ||
        vacations.length > 0 ||
        excuses.length > 0 ||
        holidays.length > 0 ||
        doubleVisits.length > 0;

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

      // A half-day (Am/Pm Only) vacation is expected to carry attendance for the
      // other half — that is normal, not a conflict. Only flag when every vacation
      // covering the day is a full day, yet a punch still exists.
      const allVacationsAreFullDay = vacations.length > 0 && vacations.every((item) => item.time === "Full day");
      if (attendance.length > 0 && vacations.length > 0 && allVacationsAreFullDay) {
        exceptions.push(createException({
          code: "attendance_during_vacation",
          date,
          description: `${employee.fullName} has fingerprint attendance while an approved full-day vacation covers the same date.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: [...attendance, ...vacations].map((item) => item.id),
          severity: "warning",
          title: "Attendance during vacation",
        }));
      }

      // Uncovered expected workday only. isExpectedWorkday already encodes the
      // full weekly-off policy correctly per role: Friday is off for everyone
      // (isFieldWorkforceFriday — unconditional, no job-title carve-out), and
      // Saturday is off for everyone except Medical Rep / District (Sales)
      // Manager, whose weekend is Friday-only (isFieldWorkforceFridayOnlyTitle).
      // A day that isn't expected to have activity for this employee (their
      // weekly off, whichever day that is) stays blank when uncovered — no
      // label, no noise — while a real captured record on any day, off or not,
      // still shows normally (items are never exception-gated). Only actually
      // recorded/verified sources count as covered — an uncovered expected
      // workday reads the same way regardless: no activity was recognized
      // anywhere, full stop.
      if (isExpectedWorkday(employee, date) && !isCovered) {
        exceptions.push(createException({
          code: "no_activity_recorded",
          date,
          description: `${employee.fullName}: no CRM double visit, no fingerprint attendance, no approved vacation, and no approved excuse recorded for this workday.`,
          employeeHrId: employee.hrId,
          employeeName: employee.fullName,
          relatedItemIds: [],
          severity: "danger",
          title: "No Activity Recorded",
        }));
      }
    }
  }

  return exceptions.sort((left, right) => `${left.date}-${left.employeeName}-${left.title}`.localeCompare(`${right.date}-${right.employeeName}-${right.title}`));
}
