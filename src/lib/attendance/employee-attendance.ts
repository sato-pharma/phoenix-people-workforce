import { getFingerprintAttendanceReport } from "@/lib/attendance/fingerprint-report";
import { getAttendanceExceptions } from "@/lib/attendance/exceptions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { compactDeductionHrId } from "@/lib/deductions-governance/service";
import { isAttendanceTracked } from "@/lib/attendance/eligibility";
import { loadActiveDeviceMappedHrIds } from "@/lib/attendance/device-user-mapping";
import { normalizeAttendanceHrId } from "@/lib/attendance/metrics";
import { normalizeHrId, type AccessContext } from "@/lib/auth/permissions";
import { isTerminalEmploymentStatus } from "@/lib/auth/session-lifecycle";

export type EmployeeAttendanceSummary = {
  absentDays: number;
  completeDays: number;
  deductionDays: number;
  exceptionDays: number;
  lateDays: number;
  shortDays: number;
  totalRows: number;
};

export type EmployeeAttendanceData = {
  dateFrom: string;
  dateTo: string;
  pendingDisputes: number;
  rows: Array<{
    date: string;
    deductionConfirmed: boolean;
    deductionDays: string;
    firstPunch: string;
    hasException: boolean;
    lastPunch: string;
    lateMinutes: string;
    rawDate: string;
    recommendedAction: string;
    status: string;
    timeLong: string;
  }>;
  summary: EmployeeAttendanceSummary;
};

async function getHrConfirmedDeductionDates(hrId: string): Promise<Set<string>> {
  const compactHrId = compactDeductionHrId(hrId);
  if (!compactHrId) return new Set();

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("deduction_candidates")
    .select("dates, deduction_decisions!inner(decision_status)")
    .eq("source_module", "ATTENDANCE_DEVICE")
    .eq("employee_hr_id_compact", compactHrId)
    .is("superseded_at", null)
    .eq("deduction_decisions.decision_status", "Approved for Payroll");

  if (error || !data) return new Set();

  const confirmed = new Set<string>();
  for (const row of data) {
    const dates = Array.isArray(row.dates) ? row.dates : [];
    for (const d of dates) {
      if (typeof d === "string") confirmed.add(d);
    }
  }
  return confirmed;
}

export async function getEmployeeAttendanceData(
  hrId: string,
  dateFrom: string,
  dateTo: string,
): Promise<EmployeeAttendanceData> {
  const [reportData, disputesData, confirmedDates] = await Promise.all([
    getFingerprintAttendanceReport({ dateFrom, dateTo, exactEmployeeHrId: hrId }),
    getAttendanceExceptions({ dateFrom, dateTo, employeeHrId: hrId, status: "pending" }),
    getHrConfirmedDeductionDates(hrId),
  ]);

  const summary: EmployeeAttendanceSummary = {
    absentDays: 0,
    completeDays: 0,
    deductionDays: 0,
    exceptionDays: 0,
    lateDays: 0,
    shortDays: 0,
    totalRows: reportData.rows.length,
  };

  const rows = reportData.rows.map((row) => {
    const s = row.status;
    if (s === "Complete") summary.completeDays++;
    else if (s === "Late" || s === "Early leave") summary.lateDays++;
    else if (s === "Short day") summary.shortDays++;
    else if (s === "Absence" || s === "Single punch") summary.absentDays++;
    if (s === "Exception") summary.exceptionDays++;

    const dd = parseFloat(row.deductionDays);
    const rawDate = row.sortKey.slice(0, 10);
    const deductionConfirmed = dd > 0 && confirmedDates.has(rawDate);
    if (deductionConfirmed) summary.deductionDays++;

    return {
      date: row.date,
      deductionConfirmed,
      deductionDays: row.deductionDays,
      firstPunch: row.actualFirstPunch,
      hasException: row.hasException ?? false,
      lastPunch: row.actualLastPunch,
      lateMinutes: row.lateMinutes,
      rawDate,
      recommendedAction: row.recommendedAction,
      status: row.status,
      timeLong: row.timeLong,
    };
  });

  return {
    dateFrom,
    dateTo,
    pendingDisputes: disputesData.length,
    rows,
    summary,
  };
}

// ─── Manager view: who may see whose fingerprint report ─────────────────────

/** Exact, normalized HR_ID equality (never substring — avoids B-1 vs B-10 leakage). */
function sameHrId(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeHrId(left);
  const b = normalizeHrId(right);
  return Boolean(a) && a === b;
}

export type AttendanceViewTarget = {
  hrId: string;
  managerHrId: string | null;
};

export type AttendanceReportTarget = {
  hrId: string;
  fullName: string;
  jobTitle: string;
};

/**
 * Whether `context` may view the fingerprint/attendance report of `target`.
 *
 *  - self — always.
 *  - whole-company viewers (Super Admin, CEO, or company/system scope) — anyone.
 *  - any other manager — their DIRECT reports only (target.managerHrId === caller).
 *
 * Pure + exact-match; the security boundary for the manager view. Guests / no-scope
 * are denied outright.
 */
export function canViewEmployeeAttendanceReport(
  context: AccessContext,
  target: AttendanceViewTarget,
): boolean {
  if (context.source === "guest" || context.scope === "none") return false;
  const caller = normalizeHrId(context.hrId);
  const targetHrId = normalizeHrId(target.hrId);
  if (!caller || !targetHrId) return false;

  if (sameHrId(caller, targetHrId)) return true; // self

  // Whole-company visibility (CEO / Super Admin / company-or-system scope).
  if (
    context.scope === "system" ||
    context.scope === "company" ||
    context.role === "Super Admin" ||
    context.role === "CEO"
  ) {
    return true;
  }

  // Otherwise: direct reports only.
  return sameHrId(caller, target.managerHrId);
}

/**
 * Throws `Forbidden: ...` unless `context` may view `targetHrId`'s report. Resolves
 * the target's manager from the DB only when needed (i.e. not self / not company-wide),
 * so the common self path stays a single fast in-memory check.
 */
export async function assertCanViewEmployeeAttendance(
  context: AccessContext,
  targetHrId: string,
): Promise<void> {
  const caller = normalizeHrId(context.hrId);
  const target = normalizeHrId(targetHrId);
  if (!caller || !target) {
    throw new Error("Forbidden: attendance access denied.");
  }
  // Self or whole-company viewers need no employee lookup.
  if (canViewEmployeeAttendanceReport(context, { hrId: target, managerHrId: null })) {
    return;
  }
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("employees")
    .select("manager_hr_id")
    .eq("hr_id", target.toUpperCase())
    .maybeSingle();
  const managerHrId = (data as { manager_hr_id: string | null } | null)?.manager_hr_id ?? null;
  if (!canViewEmployeeAttendanceReport(context, { hrId: target, managerHrId })) {
    throw new Error(`Forbidden: ${context.role} cannot view attendance for another employee.`);
  }
}

/**
 * Active DIRECT reports of `managerHrId` who are attendance-tracked (device-enrolled
 * or a field role) — used to populate the manager's report selector. Returns [] when
 * none. Terminated/resigned reports are excluded.
 */
export async function loadAttendanceDirectReports(managerHrId: string): Promise<AttendanceReportTarget[]> {
  const normalized = normalizeHrId(managerHrId);
  if (!normalized) return [];

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("employees")
    .select("hr_id, full_name, job_title, employment_status, manager_hr_id")
    .eq("manager_hr_id", normalized.toUpperCase());
  if (error || !data) return [];

  const deviceMapped = await loadActiveDeviceMappedHrIds();
  return (data as Array<{
    hr_id: string;
    full_name: string | null;
    job_title: string | null;
    employment_status: string | null;
    manager_hr_id: string | null;
  }>)
    .filter((row) => sameHrId(row.manager_hr_id, normalized))
    .filter((row) => !isTerminalEmploymentStatus(row.employment_status))
    .filter((row) =>
      isAttendanceTracked({
        // The device-mapped set is keyed by normalizeAttendanceHrId (UPPERCASE);
        // match that exactly — permissions.normalizeHrId is lowercase and would miss.
        hasDeviceMapping: deviceMapped.has(normalizeAttendanceHrId(row.hr_id) ?? ""),
        jobTitle: row.job_title,
      }),
    )
    .map((row) => ({
      hrId: normalizeHrId(row.hr_id) ?? row.hr_id,
      fullName: row.full_name?.trim() || row.hr_id,
      jobTitle: row.job_title?.trim() || "",
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName));
}

/**
 * hrIds `context` may see in bulk attendance exports/reports: `null` means no
 * restriction (whole company). Mirrors `canViewEmployeeAttendanceReport`'s bypass
 * (self / whole-company viewers / direct reports only) for list-scoped callers.
 * Direct-report hrIds come back from `loadAttendanceDirectReports` normalized via
 * permissions.normalizeHrId (lowercase) — re-normalize with normalizeAttendanceHrId
 * (UPPERCASE) here since that's what fingerprint-report.ts/roster.ts compare against.
 */
export async function resolveAttendanceScopeHrIds(context: AccessContext): Promise<string[] | null> {
  if (context.source === "guest" || context.scope === "none") {
    throw new Error("Forbidden: attendance access denied.");
  }
  if (
    context.scope === "system" ||
    context.scope === "company" ||
    context.role === "Super Admin" ||
    context.role === "CEO"
  ) {
    return null;
  }
  const caller = normalizeAttendanceHrId(context.hrId);
  if (!caller) {
    throw new Error("Forbidden: attendance access denied.");
  }
  const directReports = await loadAttendanceDirectReports(caller);
  return [caller, ...directReports.map((report) => normalizeAttendanceHrId(report.hrId) ?? report.hrId)];
}
