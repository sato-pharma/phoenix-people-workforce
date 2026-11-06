import { fetchAllRows } from "@/lib/supabase/paginated";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { resolveEmployeeDisplayName } from "@/lib/employees/display-name";
import {
  normalizeAttendanceHrId,
  resolveActiveAttendancePolicy,
  resolvePolicyAttendanceStatus,
  summarizeFingerprintRows,
  type PolicyAttendanceStatusResult,
} from "@/lib/attendance/metrics";
import { getAttendanceExceptionMap } from "@/lib/attendance/exceptions";
import { loadAttendanceFlexPolicyGroups, type AttendanceFlexPolicyGroupDbRow } from "@/lib/attendance/policy-groups";
import { formatAttendanceWorkingWeekdays } from "@/lib/attendance/work-schedule";
import { isAttendanceTracked } from "@/lib/attendance/eligibility";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { cairoMidnightUtcIso } from "@/lib/attendance/timezone";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";
import {
  bracketsForEventType,
  evaluateFlexibleHoursDay,
  halfDayEffectiveStartMinutes,
  requiredMinutesForHalfDayVacation,
  type FlexibleHoursConfig,
} from "@/lib/attendance/flexible-hours";
import { isAttendanceDeductionCancelled } from "@/lib/attendance/digest-reconcile";
// The day rate is Base ÷ the month's ACTUAL calendar days, and this is now the only
// implementation of it — see the note in attendance/employee-day-report.ts for the ÷30 twin
// that used to share this name and the July 2026 figures it got wrong. THIS file is the one
// the deductions Fingerprint connector reads (`row.deductionValue`), so it is the load site
// that actually moves money, which is why the month travels with every call below.
import { calculateDeductionAmountFromBaseSalary } from "@/lib/deductions/calculations.ts";
import { getApprovedLeaveDayMap, isIsoDate } from "@/lib/attendance/working-days";
import { getApprovedExcuseDayMap } from "@/lib/attendance/approved-excuse-days";
import { getCrmActivityDayMaps } from "@/lib/attendance/crm-day-maps";
import { getPlanOfficeDayDetailMap } from "@/lib/attendance/plan-office-days";
import { judgedHalfDayPart, planOfficeDayLabel } from "@/lib/attendance/plan-office-resolution";

const reportTimeZone = process.env.ATTENDANCE_REPORT_TIME_ZONE || "Africa/Cairo";

export type FingerprintReportColumnKey =
  | "deviceUserId"
  | "employeeHrId"
  | "employeeName"
  | "jobTitle"
  | "scheduledStart"
  | "scheduledEnd"
  | "graceMinutes"
  | "actualFirstPunch"
  | "actualLastPunch"
  | "lateMinutes"
  | "earlyLeaveMinutes"
  | "department"
  | "timeLong"
  | "validTime"
  | "date"
  | "status"
  | "recommendedAction"
  | "deductionDays"
  | "deductionValue"
  | "approvedLeave"
  | "approvedExcuse"
  | "crmActivity"
  | "weeklyPlan";

export type FingerprintReportColumn = {
  always?: boolean;
  key: FingerprintReportColumnKey;
  label: string;
};

export type FingerprintReportRow = Record<FingerprintReportColumnKey, string> & {
  dateIso: string;
  // What a deduction line stores: the full name. `employeeName` is what a screen prints.
  employeeFullName?: string;
  // Set when an approved Am/Pm-Only vacation covered part of this day — the
  // "Complete" status above was judged against a halved required-minutes
  // window, not the full day, so downstream display should not call it a
  // "full" day.
  halfDayVacationPart?: "am_only" | "pm_only";
  hasException?: boolean;
  sortKey: string;
};

export type FingerprintPolicyDetailRow = {
  employeeFullName?: string;
  department: string;
  effectiveFrom: string;
  effectiveTo: string;
  employeeHrId: string;
  employeeName: string;
  graceMinutes: string;
  jobTitle: string;
  policyName: string;
  scheduledEnd: string;
  scheduledStart: string;
  targetType: string;
  workingDays: string;
  /** The policy's raw working weekdays (null = the standard weekend rule) — workingDays is its printed form. */
  workingWeekdays?: unknown;
};

export type FingerprintReportData = {
  columns: FingerprintReportColumn[];
  filters: {
    dateFrom: string;
    dateTo: string;
    deduction: string;
    department: string;
    deviceUserId: string;
    // Substring match — for admin free-text search only.
    employeeHrId: string;
    // Exact, normalized match — used to lock a report to a single employee
    // (e.g. the self-service portal). Never use the substring filter for scoping.
    exactEmployeeHrId: string;
    employeeName: string;
    jobTitle: string;
    search: string;
    status: string;
  };
  // True when the punch query was capped and rows may be incomplete.
  truncated: boolean;
  hasDateRange: boolean;
  policyDetails: FingerprintPolicyDetailRow[];
  rows: FingerprintReportRow[];
  summary: {
    complete: number;
    deductions: number;
    rows: number;
    shortDays: number;
    singlePunches: number;
  };
};

type RawPunchRow = {
  device_user_id: string;
  employee_hr_id: string | null;
  punch_time: string;
};

type EmployeeRow = {
  nickname?: string | null;
  base_salary: number | null;
  department_id: number | null;
  employment_status: string | null;
  full_name: string | null;
  hr_id: string;
  job_title: string | null;
  last_working_date: string | null;
};

type DepartmentRow = {
  id: number;
  name: string | null;
};

type PolicyRuleRow = {
  deduction_days: number | string | null;
  deduction_value: number | string | null;
  event_type: string | null;
  from_minutes: number | null;
  is_active: boolean | null;
  policy_id: number;
  recommended_action: string | null;
  sort_order: number | null;
  to_minutes: number | null;
};

type PunchBucket = {
  deviceUserId: string;
  employeeHrId: string;
  punches: Date[];
  reportDate: string;
};

type HalfDayVacationDbRow = {
  day_part: string | null;
  employee_hr_id: string;
  end_date: string | null;
  start_date: string;
};

type HalfDayVacationPart = "am_only" | "pm_only";

/**
 * Approved half-day (Am/Pm Only) vacations, keyed by `${normalizedHrId}|${dateIso}`.
 * An approved half-day vacation covers exactly one half of the shift — the other
 * half is expected to carry a punch and must not be judged against the FULL day's
 * required minutes (that was the July 2026 "Short day" false-positive: a PM-only
 * vacation + a complete AM punch getting docked as if the whole day were required).
 * Full-day leave is unaffected here — it is already gated out upstream by
 * `hasApprovedLeave` in the payroll digest's reconcileDay, and by the private
 * calendar's own vacation-covers-the-day check; this map only ever softens the
 * required-minutes window, never skips judgment outright.
 */
async function loadApprovedHalfDayVacationMap(
  employeeHrIds: string[],
  dateFrom: string,
  dateTo: string,
): Promise<Map<string, HalfDayVacationPart>> {
  const map = new Map<string, HalfDayVacationPart>();
  if (employeeHrIds.length === 0) return map;
  try {
    const supabase = getSupabaseAdmin();
    // Paged: a fixed cap would drop later half-day vacations, and their days would be judged as full days.
    const data = await fetchAllRows<HalfDayVacationDbRow>(
      () =>
        supabase
          .from("v2_vacation_requests")
          .select("employee_hr_id,start_date,end_date,day_part")
          .eq("status", "approved")
          .in("day_part", ["am_only", "pm_only"])
          .lte("start_date", dateTo)
          .gte("end_date", dateFrom),
      "id",
    );

    for (const row of data) {
      const hrId = normalizeHrId(row.employee_hr_id);
      const part = row.day_part as HalfDayVacationPart;
      if (!hrId || (part !== "am_only" && part !== "pm_only")) continue;
      // A half-day vacation is, by definition, a single date — but iterate the
      // (start, end) range defensively rather than assuming start === end.
      const start = row.start_date;
      const end = row.end_date || row.start_date;
      let cursor = start;
      let guard = 0;
      while (cursor <= end && guard < 31) {
        if (cursor >= dateFrom && cursor <= dateTo) map.set(`${hrId}|${cursor}`, part);
        const next = new Date(`${cursor}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        cursor = next.toISOString().slice(0, 10);
        guard += 1;
      }
    }
  } catch {
    // Best-effort: if v2_vacation_requests is unavailable, fall back to judging
    // the full day rather than failing the whole report.
  }
  return map;
}

export const fingerprintReportColumns: FingerprintReportColumn[] = [
  { always: true, key: "deviceUserId", label: "AC-No." },
  { always: true, key: "employeeHrId", label: "Employee ID" },
  { always: true, key: "employeeName", label: "Name" },
  { always: true, key: "jobTitle", label: "Job Title" },
  { always: true, key: "actualFirstPunch", label: "Actual First Punch" },
  { always: true, key: "actualLastPunch", label: "Actual Last Punch" },
  { always: true, key: "lateMinutes", label: "Late Minutes" },
  { always: true, key: "earlyLeaveMinutes", label: "Early Leave Minutes" },
  { key: "department", label: "Department" },
  { always: true, key: "timeLong", label: "Time long" },
  { always: true, key: "validTime", label: "Valid time" },
  { always: true, key: "date", label: "Date" },
  { always: true, key: "status", label: "Status" },
  { always: true, key: "deductionDays", label: "Deduction Days" },
  { always: true, key: "deductionValue", label: "Deduction Amount" },
  // Owner request 2026-07-24: give the export enough context (CRM visit, approved vacation/leave,
  // approved excuse, weekly-plan office/field designation) to manually re-verify a day's deduction
  // the same way the Employee Day-by-Day Report's reconcileDay gate does -- this report's own
  // status/deduction math is intentionally left untouched (see statusFromFlexibleHours), these
  // columns are supporting evidence only — with ONE exception since 2026-10-19 (owner: "deductions
  // follow it too"): on an office-days-only seat, a half-Office plan day is judged on its office
  // half (judgedHalfDayPart), and the Weekly Plan cell then names that half. Not `always`: the
  // on-screen table hides them on a day with nothing to show, but the export always includes them
  // (generateFingerprintReportWorkbook renders every entry in `columns`, not just the
  // on-screen-visible subset).
  { key: "approvedLeave", label: "Approved Vacation/Leave" },
  { key: "approvedExcuse", label: "Approved Excuse" },
  { key: "crmActivity", label: "CRM Activity" },
  { key: "weeklyPlan", label: "Weekly Plan" },
  { always: true, key: "recommendedAction", label: "Recommended Action" },
];

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function normalizeDateInput(value: string | undefined, fallback: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")) ? String(value) : fallback;
}

function isDateInput(value: string | undefined) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""));
}

function todayKey() {
  return localDateKey(new Date());
}

function localDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: reportTimeZone,
    year: "numeric",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function localTime(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: true,
    minute: "2-digit",
    timeZone: reportTimeZone,
  }).format(date);
}

function localMinutesOfDay(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone: reportTimeZone,
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? NaN);
  const hour = value("hour");
  const minute = value("minute");
  return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : null;
}

function displayPolicyTime(value: string | null | undefined) {
  const [hourText, minuteText] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return "";
  const period = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${pad(minute)} ${period}`;
}

function displayDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return `${pad(month)}/${pad(day)}/${year}`;
}

function durationText(milliseconds: number) {
  const safeMs = Math.max(0, milliseconds);
  const totalMinutes = Math.floor(safeMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${pad(hours)}:${pad(minutes)}`;
}

function normalizeHrId(value: string | null | undefined) {
  return normalizeAttendanceHrId(value);
}

function employeeProfileScore(employee: EmployeeRow) {
  return [
    employee.full_name,
    employee.job_title,
    typeof employee.department_id === "number" ? String(employee.department_id) : "",
  ].filter((value) => String(value ?? "").trim().length > 0).length;
}

function uniqueEmployeesByHrId(rows: EmployeeRow[]) {
  const byHrId = new Map<string, EmployeeRow>();
  for (const employee of rows) {
    const hrId = normalizeHrId(employee.hr_id);
    if (!hrId) continue;
    const normalizedEmployee = { ...employee, hr_id: hrId };
    const existing = byHrId.get(hrId);
    if (!existing || employeeProfileScore(normalizedEmployee) > employeeProfileScore(existing)) {
      byHrId.set(hrId, normalizedEmployee);
    }
  }
  return Array.from(byHrId.values());
}

function contains(value: string, filter: string) {
  return !filter || value.toLowerCase().includes(filter.toLowerCase());
}

// The screen prints the display name, and HR may still type the legal one.
function nameMatches(row: { employeeFullName?: string; employeeName: string }, filter: string) {
  return contains(row.employeeName, filter) || contains(row.employeeFullName ?? "", filter);
}

function textMatches(row: FingerprintReportRow, filters: FingerprintReportData["filters"]) {
  // Exact-match scoping (self-service portal): lock to a single employee. This
  // must be an exact normalized comparison, never a substring, or one employee's
  // HR_ID (e.g. "B-1") would leak every superset ID ("B-10", "B-100", ...).
  if (filters.exactEmployeeHrId && normalizeHrId(row.employeeHrId) !== filters.exactEmployeeHrId) {
    return false;
  }
  const search = filters.search;
  if (
    !contains(row.deviceUserId, filters.deviceUserId) ||
    !contains(row.employeeHrId, filters.employeeHrId) ||
    !nameMatches(row, filters.employeeName) ||
    !contains(row.jobTitle, filters.jobTitle) ||
    !contains(row.department, filters.department) ||
    !contains(row.status, filters.status) ||
    !contains(row.deductionDays || row.deductionValue || row.recommendedAction, filters.deduction)
  ) {
    return false;
  }

  if (!search) return true;
  const haystack = [
    row.deviceUserId,
    row.employeeHrId,
    row.employeeName,
    row.employeeFullName,
    row.jobTitle,
    row.department,
    row.date,
    row.status,
    row.recommendedAction,
    row.deductionDays,
    row.deductionValue,
  ].join(" ").toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function employeePolicyMatches(row: FingerprintPolicyDetailRow, filters: FingerprintReportData["filters"]) {
  // Same exact-match scoping as rows — keeps the Policy Details export sheet from
  // leaking other employees when a report is locked to one person.
  if (filters.exactEmployeeHrId && normalizeHrId(row.employeeHrId) !== filters.exactEmployeeHrId) {
    return false;
  }
  if (
    !contains(row.employeeHrId, filters.employeeHrId) ||
    !nameMatches(row, filters.employeeName) ||
    !contains(row.jobTitle, filters.jobTitle) ||
    !contains(row.department, filters.department)
  ) {
    return false;
  }

  if (!filters.search) return true;
  return [
    row.employeeHrId,
    row.employeeName,
    row.employeeFullName,
    row.jobTitle,
    row.department,
    row.policyName,
    row.scheduledStart,
    row.scheduledEnd,
    row.graceMinutes,
    row.workingDays,
  ].join(" ").toLowerCase().includes(filters.search.toLowerCase());
}

function policyTimeToMinutes(value: string | null | undefined): number | null {
  const [hourText, minuteText] = String(value ?? "").slice(0, 5).split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  return hour * 60 + minute;
}

/**
 * Computes one row's status/deduction via the SAME flexible-hours engine the weekly digest
 * uses to actually settle payroll deductions (evaluateFlexibleHoursDay in flexible-hours.ts),
 * for any policy that has been migrated onto that model (required_minutes set). Owner-confirmed
 * 2026-07-21: this report must never independently re-derive a different number for a policy
 * the digest engine already governs — only employees explicitly excepted from the model
 * (required_minutes: null) still fall back to the older grace-period formula below.
 *
 * Maps the engine's own status vocabulary onto this report's pre-existing labels ("Short
 * hours" -> "Short day", "Missing punch" -> "Single punch") so every downstream consumer of
 * this report (employee-attendance, monthly-summary, analytics, the FWC cross-check, the
 * portal) keeps working against the status strings it already pattern-matches on — only the
 * underlying calculation changed, not the report's contract.
 */
function statusFromFlexibleHours(input: {
  baseSalary: number | null;
  policy: AttendanceFlexPolicyGroupDbRow;
  rules: PolicyRuleRow[];
  firstPunchMinutes: number | null;
  lastPunchMinutes: number | null;
  visiblePunchCount: number;
  // An approved Am/Pm-Only vacation covering this day halves the required
  // presence instead of judging against the full scheduled day.
  halfDayVacationPart: HalfDayVacationPart | null;
  // The day being charged, so the day rate divides by THAT month's actual
  // calendar days. Required, not optional: an optional month would silently
  // fall back to a flat 30 again, which is the exact defect this closes.
  reportDate: string;
}): PolicyAttendanceStatusResult {
  const scheduledStartMinutes = policyTimeToMinutes(input.policy.scheduled_start) ?? 9 * 60;
  const requiredMinutes = requiredMinutesForHalfDayVacation(input.policy.required_minutes!, input.halfDayVacationPart);
  // An AM-only vacation moves the obligation to the SECOND half of the shift, so
  // lateness must be judged from where that half BEGINS — not from a morning
  // start the employee was formally excused from. requiredMinutes is already the
  // halved figure, so the worked half opens exactly that far after the scheduled
  // start. Only am_only shifts: a PM-only vacation still owes the morning, and
  // its start is already correct.
  //
  // The short-hours half of this judgment was always right (the requirement is
  // halved above); it was lateness alone that kept measuring against a start
  // that no longer applied. Measured on August 2026 production data it charged
  // two people 0.25 day each for "lateness" on a morning they had approved off,
  // both of whom then completed the halved hours in full: A-7 on 08-02 (arrived
  // 10:56, called 86 min late, 177.42 EGP) and A-9 on 08-02 (arrived 12:54,
  // called 204 min late, 387.10 EGP). Owner decision 2026-09-08, asked and
  // answered: judge the worked half.
  const effectiveStartMinutes = halfDayEffectiveStartMinutes(
    scheduledStartMinutes,
    requiredMinutes,
    input.halfDayVacationPart,
  );
  const config: FlexibleHoursConfig = {
    scheduledStartMinutes: effectiveStartMinutes,
    flexCeilingMinutes: effectiveStartMinutes + (input.policy.flex_minutes ?? 0),
    requiredMinutes,
  };
  const result = evaluateFlexibleHoursDay({
    config,
    firstPunchMinutes: input.firstPunchMinutes,
    lastPunchMinutes: input.lastPunchMinutes,
    lateBrackets: bracketsForEventType(input.rules, input.policy.id, "late"),
    shortBrackets: bracketsForEventType(input.rules, input.policy.id, "short_hours"),
    visiblePunchCount: input.visiblePunchCount,
  });

  const status = result.status === "Short hours" ? "Short day" : result.status === "Missing punch" ? "Single punch" : result.status;
  const deductionValue = result.deductionDays > 0
    ? calculateDeductionAmountFromBaseSalary({
        baseSalary: input.baseSalary ?? 0,
        deductionDays: result.deductionDays,
        month: Number(input.reportDate.slice(5, 7)),
        year: Number(input.reportDate.slice(0, 4)),
      })
    : 0;

  return {
    deductionDays: String(result.deductionDays),
    deductionValue: result.deductionDays <= 0 ? "0" : deductionValue != null ? deductionValue.toFixed(2) : "Base salary missing",
    earlyLeaveMinutes: "",
    lateMinutes: result.lateMinutes > 0 ? String(result.lateMinutes) : "",
    recommendedAction: result.reason ?? "",
    status,
  };
}

// A page is PostgREST's own 1,000 rows: a larger page would end on a "short" page the moment a server
// ceiling cut it, and the rest of the month would vanish without a word.
const PUNCH_PAGE = 1000;

export async function getFingerprintAttendanceReport(input: {
  dateFrom?: string;
  dateTo?: string;
  deduction?: string;
  department?: string;
  deviceUserId?: string;
  employeeHrId?: string;
  exactEmployeeHrId?: string;
  // Allow-list of hrIds a scoped caller (e.g. a team-scoped manager export) may see.
  // Undefined/omitted = no restriction. Never use the substring `employeeHrId` filter
  // for scoping — only this and `exactEmployeeHrId` are hard boundaries.
  employeeHrIds?: string[];
  employeeName?: string;
  jobTitle?: string;
  search?: string;
  status?: string;
} = {}): Promise<FingerprintReportData> {
  const hasDateRange = isDateInput(input.dateFrom) && isDateInput(input.dateTo);
  const dateFrom = normalizeDateInput(input.dateFrom, "");
  const dateTo = normalizeDateInput(input.dateTo, "");
  const filters = {
    dateFrom,
    dateTo,
    deduction: String(input.deduction ?? "").trim(),
    department: String(input.department ?? "").trim(),
    deviceUserId: String(input.deviceUserId ?? "").trim(),
    employeeHrId: String(input.employeeHrId ?? "").trim(),
    exactEmployeeHrId: normalizeHrId(input.exactEmployeeHrId) ?? "",
    employeeName: String(input.employeeName ?? "").trim(),
    jobTitle: String(input.jobTitle ?? "").trim(),
    search: String(input.search ?? "").trim(),
    status: String(input.status ?? "").trim(),
  };
  const scopeHrIds = input.employeeHrIds
    ? new Set(input.employeeHrIds.map((id) => normalizeHrId(id)).filter((value): value is string => Boolean(value)))
    : null;
  const supabase = getSupabaseAdmin();
  const effectiveDateFrom = hasDateRange ? dateFrom : todayKey();
  const effectiveDateTo = hasDateRange ? dateTo : todayKey();

  const [employeeResult, policyRows, ruleResult, deviceMappedHrIds] = await Promise.all([
    supabase
      .from("employees")
      .select("hr_id,full_name,nickname,job_title,department_id,base_salary,employment_status,last_working_date")
      .order("full_name"),
    loadAttendanceFlexPolicyGroups({ activeOnly: true }),
    supabase
      .from("attendance_policy_rules")
      .select("policy_id,event_type,from_minutes,to_minutes,recommended_action,deduction_days,deduction_value,is_active,sort_order")
      .eq("is_active", true)
      .order("sort_order"),
    loadActiveDeviceMappedHrIds(),
  ]);

  if (employeeResult.error) throw employeeResult.error;
  if (ruleResult.error) throw ruleResult.error;

  const allEmployees = uniqueEmployeesByHrId((employeeResult.data ?? []) as EmployeeRow[]);
  // An employee is attendance-tracked when actively enrolled on a fingerprint
  // device (authoritative — covers office/HQ staff who punch the office device)
  // OR is a field role by title (Medical Rep / DM / RSM). See isAttendanceTracked.
  const eligibleEmployees = allEmployees
    .filter((emp) =>
      isAttendanceTracked({
        hasDeviceMapping: deviceMappedHrIds.has(normalizeHrId(emp.hr_id) ?? ""),
        jobTitle: emp.job_title,
      }),
    )
    // Resigned/terminated employees are excluded once their last working date is
    // behind the reported range — this is a deductions/payroll report, so a leaver
    // must not keep generating rows (and deduction amounts) forever. Mirrors the
    // proven-correct exclusion in attendance/roster.ts's getAttendanceRoster.
    .filter((emp) => {
      if (!isTerminalEmploymentStatus(emp.employment_status)) return true;
      const lastWorkingDate = isIsoDate(emp.last_working_date) ? emp.last_working_date : null;
      // Exited before the reported range starts (or exit date unknown) — not expected at all.
      if (!lastWorkingDate || lastWorkingDate < effectiveDateFrom) return false;
      return true;
    })
    .filter((emp) => !scopeHrIds || scopeHrIds.has(normalizeHrId(emp.hr_id) ?? ""));
  const allDepartmentIds = new Set<number>();
  for (const employee of eligibleEmployees) {
    if (typeof employee.department_id === "number") allDepartmentIds.add(employee.department_id);
  }

  const departmentMap = new Map<number, string>();
  if (allDepartmentIds.size > 0) {
    const { data: departmentData, error: departmentError } = await supabase
      .from("departments")
      .select("id,name")
      .in("id", Array.from(allDepartmentIds));

    if (departmentError) throw departmentError;

    for (const department of (departmentData ?? []) as DepartmentRow[]) {
      departmentMap.set(department.id, department.name?.trim() || "");
    }
  }

  const activePolicyRows = policyRows as AttendanceFlexPolicyGroupDbRow[];
  const rulesByPolicy = new Map<number, PolicyRuleRow[]>();
  for (const rule of (ruleResult.data ?? []) as PolicyRuleRow[]) {
    const list = rulesByPolicy.get(rule.policy_id) ?? [];
    list.push(rule);
    rulesByPolicy.set(rule.policy_id, list);
  }
  const policyDetails = eligibleEmployees
    .map((employee) => {
      const policy = resolveActiveAttendancePolicy(employee, activePolicyRows, effectiveDateFrom, effectiveDateTo);
      const department = typeof employee.department_id === "number"
        ? departmentMap.get(employee.department_id) ?? ""
        : "";

      return {
        department,
        effectiveFrom: policy?.effective_from ?? "",
        effectiveTo: policy?.effective_to ?? "",
        employeeFullName: employee.full_name?.trim() || employee.hr_id,
        employeeHrId: normalizeHrId(employee.hr_id) ?? employee.hr_id,
        employeeName: resolveEmployeeDisplayName(employee.full_name?.trim() || employee.hr_id, employee.nickname, employee.hr_id),
        graceMinutes: policy?.grace_minutes == null ? "" : String(policy.grace_minutes),
        jobTitle: employee.job_title?.trim() || "",
        policyName: policy?.policy_name?.trim() || "No active policy",
        scheduledEnd: displayPolicyTime(policy?.scheduled_end),
        scheduledStart: displayPolicyTime(policy?.scheduled_start),
        targetType: policy?.target_type ?? "",
        workingDays: formatAttendanceWorkingWeekdays(policy?.working_weekdays),
        workingWeekdays: policy?.working_weekdays ?? null,
      };
    })
    .filter((row) => employeePolicyMatches(row, filters))
    .sort((left, right) => left.employeeName.localeCompare(right.employeeName));

  if (!hasDateRange) {
    return {
      columns: fingerprintReportColumns,
      filters,
      hasDateRange,
      policyDetails,
      rows: [],
      summary: {
        complete: 0,
        deductions: 0,
        rows: 0,
        shortDays: 0,
        singlePunches: 0,
      },
      truncated: false,
    };
  }

  // Page through punches so a busy month is never silently cut off at the cap.
  // When the report is locked to one employee we also scope the query to them —
  // a hard data-layer boundary that removes any cross-employee truncation risk.
  const punches: RawPunchRow[] = [];
  let truncated = false;
  let pageOffset = 0;
  // Safety ceiling so a runaway range can't loop forever; surfaced as `truncated`.
  const MAX_PUNCHES = 200000;
  while (true) {
    let punchQuery = supabase
      .from("attendance_raw_punches")
      .select("device_user_id,employee_hr_id,punch_time")
      .not("employee_hr_id", "is", null)
      .gte("punch_time", cairoMidnightUtcIso(dateFrom))
      .lt("punch_time", cairoMidnightUtcIso(dateTo, 1));
    if (filters.exactEmployeeHrId) {
      punchQuery = punchQuery.eq("employee_hr_id", filters.exactEmployeeHrId);
    }
    // The id tiebreak keeps punches with the same time from being lost or repeated between pages.
    const { data: punchPage, error: punchError } = await punchQuery
      .order("punch_time", { ascending: true })
      .order("id", { ascending: true })
      .range(pageOffset, pageOffset + PUNCH_PAGE - 1);

    if (punchError) throw punchError;

    const page = (punchPage ?? []) as RawPunchRow[];
    punches.push(...page);
    if (page.length < PUNCH_PAGE) break;
    pageOffset += PUNCH_PAGE;
    if (punches.length >= MAX_PUNCHES) {
      truncated = true;
      break;
    }
  }
  const employeeHrIds = Array.from(new Set(punches.map((row) => normalizeHrId(row.employee_hr_id)).filter((value): value is string => Boolean(value))));
  const employeeMap = new Map<string, EmployeeRow>();

  for (const employee of eligibleEmployees) {
    const hrId = normalizeHrId(employee.hr_id);
    if (hrId && employeeHrIds.includes(hrId)) employeeMap.set(hrId, employee);
  }

  const [exceptionMap, halfDayVacationMap, approvedLeaveMap, approvedExcuseMap, crmActivity, planOfficeMap] = await Promise.all([
    getAttendanceExceptionMap(employeeHrIds, dateFrom, dateTo),
    loadApprovedHalfDayVacationMap(employeeHrIds, dateFrom, dateTo),
    getApprovedLeaveDayMap({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds }),
    getApprovedExcuseDayMap({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds }),
    getCrmActivityDayMaps({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds }),
    getPlanOfficeDayDetailMap({ dateFromIso: dateFrom, dateToIso: dateTo, employeeHrIds }),
  ]);

  const buckets = new Map<string, PunchBucket>();
  for (const punch of punches) {
    const employeeHrId = normalizeHrId(punch.employee_hr_id);
    if (!employeeHrId) continue;
    const punchDate = new Date(punch.punch_time);
    const reportDate = localDateKey(punchDate);
    const key = `${employeeHrId}\u0000${reportDate}`;
    const bucket = buckets.get(key) ?? {
      deviceUserId: punch.device_user_id,
      employeeHrId,
      punches: [],
      reportDate,
    };
    bucket.punches.push(punchDate);
    if (!bucket.deviceUserId && punch.device_user_id) {
      bucket.deviceUserId = punch.device_user_id;
    }
    buckets.set(key, bucket);
  }

  const rows = Array.from(buckets.values()).map((bucket) => {
    bucket.punches.sort((left, right) => left.getTime() - right.getTime());
    const firstPunch = bucket.punches[0];
    const lastPunch = bucket.punches[bucket.punches.length - 1];
    const visiblePunchTimes = Array.from(new Set(bucket.punches.map((punch) => localTime(punch))));
    const firstPunchText = firstPunch ? localTime(firstPunch) : "";
    const lastPunchText = lastPunch ? localTime(lastPunch) : "";
    const hasDistinctVisibleLastPunch = firstPunchText.length > 0 && lastPunchText.length > 0 && firstPunchText !== lastPunchText;
    const durationMs = firstPunch && lastPunch && hasDistinctVisibleLastPunch
      ? lastPunch.getTime() - firstPunch.getTime()
      : 0;
    const employee = employeeMap.get(bucket.employeeHrId);
    const policy = employee
      ? resolveActiveAttendancePolicy(employee, activePolicyRows, bucket.reportDate, bucket.reportDate)
      : null;
    const policyRules = policy ? rulesByPolicy.get(policy.id) ?? [] : [];
    const firstPunchMinutes = firstPunch ? localMinutesOfDay(firstPunch) : null;
    const lastPunchMinutes = lastPunch ? localMinutesOfDay(lastPunch) : null;
    const halfDayVacationPart = halfDayVacationMap.get(`${bucket.employeeHrId}|${bucket.reportDate}`) ?? null;
    const planDay = planOfficeMap.get(bucket.employeeHrId)?.get(bucket.reportDate);
    // The half the day is JUDGED on: an approved half-day vacation's own half, or — on an
    // office-days-only seat — the office half of a half-Office plan day (owner, 2026-10-19:
    // "deductions follow it too"). Only the judgment reads it; the cancel rule and the labels
    // below still read the real vacation alone.
    const judgedHalfPart = judgedHalfDayPart({ halfDayVacationPart, judgmentMode: policy?.judgment_mode, planDay });
    const status = policy && policy.required_minutes != null
      ? statusFromFlexibleHours({
          baseSalary: employee?.base_salary ?? null,
          firstPunchMinutes,
          halfDayVacationPart: judgedHalfPart,
          lastPunchMinutes,
          policy,
          reportDate: bucket.reportDate,
          rules: policyRules,
          visiblePunchCount: visiblePunchTimes.length,
        })
      : resolvePolicyAttendanceStatus({
          baseSalary: employee?.base_salary ?? null,
          durationMinutes: Math.floor(durationMs / 60000),
          firstPunchMinutes,
          // Passed here too, not only to the flexible-hours branch above: the two
          // policy groups with no required_minutes route through this engine, and
          // without it a half-day employee is judged against the whole scheduled day.
          halfDayVacationPart: judgedHalfPart,
          lastPunchMinutes,
          policy,
          reportDate: bucket.reportDate,
          rules: policyRules,
          visiblePunchCount: visiblePunchTimes.length,
        });
    const department = typeof employee?.department_id === "number"
      ? departmentMap.get(employee.department_id) ?? ""
      : "";

    const exceptionKey = `${bucket.employeeHrId}|${bucket.reportDate}`;
    const exception = exceptionMap.get(exceptionKey);
    const hasApprovedException = exception?.status === "approved";
    const hasPendingException = !hasApprovedException && exception?.status === "pending";

    const hasApprovedLeave = approvedLeaveMap.get(bucket.employeeHrId)?.has(bucket.reportDate) ?? false;
    const hasApprovedExcuse = approvedExcuseMap.get(bucket.employeeHrId)?.has(bucket.reportDate) ?? false;
    const hasCrmLeave = crmActivity.leaveMap.get(bucket.employeeHrId)?.has(bucket.reportDate) ?? false;
    const hasCrmFieldVisit = crmActivity.fieldVisitMap.get(bucket.employeeHrId)?.has(bucket.reportDate) ?? false;
    const crmDetail = crmActivity.detailMap.get(bucket.employeeHrId)?.get(bucket.reportDate) ?? "";

    // An approved EXCUSE cancels the day's attendance deduction, exactly as an
    // approved exception does. This was the documented policy in two places and
    // implemented in neither of the paths that actually deduct:
    //
    //   approved-excuse-days.ts — "Used to cancel an attendance deduction for a
    //                              day covered by an approved excuse"
    //   digest-reconcile.ts     — if (hasApprovedExcuse) return { action: "skip" }
    //
    // Here the flag was fetched, rendered into the `approvedExcuse` label below,
    // and then ignored when computing the money — a fail-open guard. Measured on
    // July 2026 production data it charged 1,666.66 EGP over three days that were
    // all fully covered by an approved excuse: A-9 on 07-07 (800.00, late 78 /
    // short 97 min vs 120 excused) and B-155 on 07-09 (433.33, late 86 / short 98)
    // and 07-14 (433.33, short 109).
    //
    // The same fail-open guard held for three MORE cancels that digest-reconcile.ts
    // has always called universal — a full-day approved leave, a CRM-recorded
    // leave, and a real CRM field visit. All three were fetched above, rendered
    // into the approvedLeave/crmActivity labels below, and then ignored when
    // computing the money. That mattered little while this was only a report, and
    // began moving real money when the unified Deductions module started turning
    // its rows into candidates (src/lib/deductions/connectors/fingerprint.ts reads
    // row.deductionDays). Measured on August 2026 production data it charged
    // 2,709.57 EGP over five days our own records already explained: A-1 on 08-04
    // and A-2 on 08-11 (both on approved leave), A-1 on 08-26 (CRM Annual
    // Vacation), B-155 on 08-11 (CRM Traveling, returning from Minya) and A-12 on
    // 08-24 (CRM Campaign, a logged doctor meeting). All five were still Pending
    // when this shipped — the never-auto-publish rule, not this code, is what kept
    // them off a payslip.
    //
    // A HALF-day approved vacation deliberately does NOT cancel: the employee owes
    // the other half, and statusFromFlexibleHours judges exactly that half. Owner
    // decision 2026-09-08, asked and answered: "judge the worked half".
    const deductionCancelled = isAttendanceDeductionCancelled({
      halfDayVacationPart,
      hasApprovedException,
      hasApprovedExcuse,
      hasApprovedLeave,
      hasCrmFieldVisit,
      hasCrmLeave,
    });

    return {
      actualFirstPunch: firstPunchText,
      actualLastPunch: hasDistinctVisibleLastPunch ? lastPunchText : "",
      approvedExcuse: hasApprovedExcuse ? `Approved excuse${exception ? `: ${exception.reason}` : ""}` : "",
      approvedLeave: hasApprovedLeave
        ? halfDayVacationPart
          ? `Approved vacation (${halfDayVacationPart === "am_only" ? "AM only" : "PM only"})`
          : "Approved vacation/leave"
        : hasCrmLeave
          ? `CRM-recorded leave${crmDetail ? `: ${crmDetail}` : ""}`
          : "",
      crmActivity: hasCrmFieldVisit ? crmDetail || "CRM field visit" : "",
      date: displayDate(bucket.reportDate),
      dateIso: bucket.reportDate,
      // deductionCancelled, not hasApprovedException: an approved excuse must
      // cancel the charge too. The late/short MINUTES below deliberately stay
      // factual — HR should still see that the day ran short, just not be
      // charged for it.
      deductionDays: deductionCancelled ? "0" : status.deductionDays,
      deductionValue: deductionCancelled ? "0" : status.deductionValue,
      department,
      deviceUserId: bucket.deviceUserId,
      earlyLeaveMinutes: hasApprovedException ? "0" : status.earlyLeaveMinutes,
      employeeHrId: bucket.employeeHrId,
      employeeFullName: employee?.full_name?.trim() || bucket.employeeHrId,
      employeeName: employee
        ? resolveEmployeeDisplayName(employee.full_name?.trim() || bucket.employeeHrId, employee.nickname, employee.hr_id)
        : bucket.employeeHrId,
      graceMinutes: policy?.grace_minutes == null ? "" : String(policy.grace_minutes),
      halfDayVacationPart: halfDayVacationPart ?? undefined,
      hasException: hasApprovedException,
      jobTitle: employee?.job_title?.trim() || "",
      lateMinutes: hasApprovedException ? "0" : status.lateMinutes,
      // The plan attendance followed, with the half when only one is Office, and the approved
      // monthly plan beside it when the two disagree (owner, 2026-10-19: show both).
      weeklyPlan: planOfficeDayLabel(planDay),
      recommendedAction: hasApprovedException
        ? `Exception: ${exception!.reason}`
        : hasPendingException
          ? `Pending review: ${exception!.reason}`
          : status.recommendedAction,
      scheduledEnd: displayPolicyTime(policy?.scheduled_end),
      scheduledStart: displayPolicyTime(policy?.scheduled_start),
      sortKey: `${bucket.reportDate}\u0000${bucket.employeeHrId}`,
      status: hasApprovedException ? "Exception" : status.status,
      timeLong: durationText(durationMs),
      validTime: durationText(durationMs),
    };
  })
    .filter((row) => employeeMap.has(row.employeeHrId))
    .filter((row) => textMatches(row, filters))
    .sort((left, right) => left.sortKey.localeCompare(right.sortKey));

  return {
    columns: fingerprintReportColumns,
    filters,
    hasDateRange,
    policyDetails,
    rows,
    summary: summarizeFingerprintRows(rows),
    truncated,
  };
}
