import { unstable_cache } from "next/cache.js";
import { serveWithoutCaching, unwrapServedWithoutCaching } from "@/lib/cache/serve-uncached";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import {
  classifyEmployeeNode,
  shouldFlagMissingAccessForEmployeeNode,
  type EmployeeNodeInput,
  type EmployeeNodeType,
} from "@/lib/workforce-classification";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { namesByHrId } from "@/lib/employees/names-by-hr-id";
import { isDisposableFixtureText } from "@/lib/fixture-hygiene";
import { isManagerOptionalHrId } from "@/lib/employees/hierarchy-governance";
import { summarizeDeviceUserMappings } from "@/lib/attendance/metrics";
import { buildVacationPlatformMetrics } from "@/lib/vacation/metrics";
import { getWorkforceMetrics, type UncomputedRate } from "@/lib/platform/metrics";
import { type AccessContext } from "@/lib/auth/permissions";

/**
 * The workforce-health figures the Command Center data shape and the phase-smoke scripts read.
 *
 * The /admin/data-health page this used to feed was retired on 23 Oct 2026 (it redirects to
 * /admin/system-audit). Everything ONLY that page read went with it: the sales-ownership
 * classification and its four sales queues, the orphan-HR-id view, the vacancy list, the
 * pharmacy-mapping coverage, and three node-type queues that were built only from login-eligible
 * employees and so could never be non-zero. What is left is honest about failure: a source that
 * could not be read leaves its figure `null` and names itself in `unavailable`.
 */
export type DataHealthStats = {
  summary: {
    totalEmployees: number;
    structureNodes: number;
    activeEmployees: number;
    vacantPositions: number;
    /** Active, login-eligible employees the audit graded — the ONE population both figures below use. */
    gradedEmployees: number;
    /** gradedEmployees minus the DISTINCT people among them with at least one issue. Null when access could not be read. */
    healthyEmployees: number | null;
    /** healthyEmployees ÷ gradedEmployees × 100. Null when nobody was graded or access could not be read. */
    healthRate: number | null;
    attendanceMappingIssues: number | null;
    attendanceReadinessRate: UncomputedRate;
    leaveApprovedRequests: number | null;
    leavePendingRequests: number | null;
    leaveRejectedRequests: number | null;
  };
  employeeIssues: Array<{
    hr_id: string;
    full_name: string;
    job_title: string;
    manager_hr_id: string | null;
    node_type: EmployeeNodeType;
    has_auth_user: boolean;
    has_access_profile: boolean;
    health_status: string;
    reason: string;
  }>;
  /** Plain-words names of the sources that could not be read; their figures above are `null`. */
  unavailable: string[];
};

export type SalaryFlag = {
  id: string;
  hrId: string | null;
  /** The employee's display name; filled only when asked for (`withNames`), null when not found. */
  employeeName: string | null;
  flagType: string | null;
  severity: string | null;
  message: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
};

export type SalaryFlagsResult = {
  /** EVERY matching flag — paged, never cut at a row limit. */
  flags: SalaryFlag[];
  total: number;
  unresolvedCount: number;
};

function toSalaryFlag(row: Record<string, unknown>): SalaryFlag {
  return {
    id: row.id as string,
    hrId: (row.hr_id as string | null) ?? null,
    employeeName: null,
    flagType: (row.flag_type as string | null) ?? null,
    severity: (row.severity as string | null) ?? null,
    message: (row.message as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * Salary flags, newest first. Paged in full: this used to stop at 500 rows without saying so, so
 * the 501st flag existed in the table and on no screen. With `showResolved` the list holds every
 * flag and `unresolvedCount` is counted from the same rows, so the two can never disagree.
 */
export async function getSalaryFlags(
  showResolved = false,
  options: { withNames?: boolean } = {},
): Promise<SalaryFlagsResult> {
  const supabase = getSupabaseAdmin();
  const rows = await fetchAllRows<Record<string, unknown>>(() => {
    let query = supabase
      .from("salary_flags")
      .select("id, hr_id, flag_type, severity, message, resolved_at, resolved_by, created_at")
      .order("created_at", { ascending: false });
    if (!showResolved) query = query.is("resolved_at", null);
    return query;
  }, "id");

  let flags = rows.map(toSalaryFlag);
  // Names only for the screen that lists the flags; the count-only callers (Command Center, the CEO
  // landing page, the needs-you board) do not pay for the extra read.
  if (options.withNames && flags.length > 0) {
    const names = await namesByHrId(flags.map((flag) => flag.hrId));
    flags = flags.map((flag) => ({ ...flag, employeeName: names.get(flag.hrId) }));
  }
  return {
    flags,
    total: flags.length,
    unresolvedCount: flags.filter((flag) => flag.resolvedAt === null).length,
  };
}

export async function resolveSalaryFlag(id: string, resolvedBy: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("salary_flags")
    .update({ resolved_at: new Date().toISOString(), resolved_by: resolvedBy })
    .eq("id", id);
  if (error) throw error;
}

const dataHealthAccessContext: AccessContext = {
  hrId: "DATA_HEALTH_SYSTEM",
  loginId: "data-health.system",
  role: "Super Admin",
  scope: "system",
  source: "system",
};
// unstable_cache (not a plain module-level variable) so the cache actually survives
// across serverless invocations on separate Lambda instances — a module-level `let`
// only helps repeat requests lucky enough to land on the same still-warm instance.
const DATA_HEALTH_STATS_CACHE_TTL_SECONDS = 120;

function normalizeHealthKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function rowText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function rowNumber(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function employeeToNodeInput(employee: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"][number]): EmployeeNodeInput {
  return {
    areaId: employee.areaId,
    areaName: employee.areaName,
    crmId: employee.crmId,
    crmUsername: employee.crmUsername,
    employmentStatus: employee.employmentStatus,
    fullName: employee.displayName,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineId: employee.lineId,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    positionTitle: employee.positionTitle,
    workEmail: employee.workEmail,
  };
}

/**
 * Health over ONE population: the active, login-eligible employees. `healthyEmployees` is that
 * count minus the DISTINCT people among them with an issue. The old figure subtracted the issue
 * count from the workforce-metrics headcount — two different populations — so the rate could move
 * without a single record changing. Pure, so the arithmetic is testable without a database.
 */
export function computeEmployeeHealth(input: {
  gradedHrIds: readonly string[];
  issueHrIds: readonly string[];
}): { gradedEmployees: number; healthyEmployees: number; healthRate: number | null } {
  const graded = new Set(input.gradedHrIds.map(normalizeHealthKey).filter(Boolean));
  const withIssue = new Set(input.issueHrIds.map(normalizeHealthKey).filter((key) => graded.has(key)));
  const healthyEmployees = graded.size - withIssue.size;
  return {
    gradedEmployees: graded.size,
    healthRate: graded.size > 0 ? (healthyEmployees / graded.size) * 100 : null,
    healthyEmployees,
  };
}

async function getDataHealthStatsUncached(): Promise<DataHealthStats> {
  const supabase = getSupabaseAdmin();
  const unavailable: string[] = [];

  async function settle<T>(label: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch {
      unavailable.push(label);
      return null;
    }
  }

  // The directory and the shared workforce metrics are the core: without them there is nothing to
  // grade, so their failure rejects the whole call (the Command Center names it). Every other source
  // settles on its own and leaves its own figures null.
  const [directory, sharedWorkforce, appAuthUsers, accessProfiles, attendanceMappings, vacationRows] = await Promise.all([
    getEmployeeDirectory(),
    getWorkforceMetrics(dataHealthAccessContext),
    settle("Sign-in accounts", () =>
      fetchAllRows<Record<string, unknown>>(() => supabase.from("app_auth_users").select("hr_id,is_active,login_id"), "login_id")),
    settle("Access profiles", () =>
      fetchAllRows<Record<string, unknown>>(
        () => supabase.from("user_access_profiles").select("hr_id,is_active,auth_user_id,login_id"),
        "auth_user_id",
      )),
    settle("Attendance device mappings", () =>
      fetchAllRows<Record<string, unknown>>(
        () => supabase.from("attendance_device_user_map").select("employee_hr_id,is_active,non_employee_label"),
        "id",
      )),
    // It used to `.catch(() => [])`, which turned a failed read into "no leave requests at all".
    settle("Vacation requests", () =>
      fetchAllRows<Record<string, unknown>>(
        () => supabase.from("v2_vacation_requests").select("employee_hr_id,status,payment_status,duration_days,manager_decision"),
        "id",
      )),
  ]);

  const businessEmployees = directory.employees.filter((employee) =>
    !isDisposableFixtureText(employee.hrId) && !isDisposableFixtureText(employee.fullName),
  );
  const employeeNodes = businessEmployees.map(employeeToNodeInput);
  const accessReadable = appAuthUsers !== null && accessProfiles !== null;
  const authHrIds = new Set(
    (appAuthUsers ?? [])
      .filter((row) => row.is_active !== false)
      .map((row) => normalizeHealthKey(row.hr_id))
      .filter(Boolean),
  );
  const accessProfileHrIds = new Set(
    (accessProfiles ?? [])
      .filter((row) => row.is_active !== false)
      .map((row) => normalizeHealthKey(row.hr_id))
      .filter(Boolean),
  );
  const employeeByHrId = new Map(employeeNodes.map((employee) => [normalizeHealthKey(employee.hrId), employee]));

  const employeeIssues: DataHealthStats["employeeIssues"] = [];
  const gradedHrIds: string[] = [];

  for (const employee of employeeNodes) {
    const node = classifyEmployeeNode(employee);
    if (!node.eligible_for_login) continue;

    const hrId = rowText(employee, "hrId") ?? rowText(employee, "hr_id") ?? "";
    gradedHrIds.push(hrId);
    const normalizedHrId = normalizeHealthKey(hrId);
    const hasAuthUser = authHrIds.has(normalizedHrId);
    const hasAccessProfile = accessProfileHrIds.has(normalizedHrId);
    const managerHrId = rowText(employee, "managerHrId") ?? rowText(employee, "manager_hr_id");
    const normalizedManagerHrId = normalizeHealthKey(managerHrId);

    let healthStatus = "ok";
    let reason = "Active employee access and linkage are classified.";

    // Access is graded only when both access sources were read — otherwise every employee would
    // read as "missing access" because of a failed read, not a missing account.
    if (accessReadable && shouldFlagMissingAccessForEmployeeNode(employee, { hasAccessProfile, hasAuthUser })) {
      if (!hasAuthUser && !hasAccessProfile) healthStatus = "missing_auth_access";
      else if (!hasAuthUser) healthStatus = "missing_auth_user";
      else healthStatus = "missing_access_profile";
      reason = "Active employee is eligible for login but is missing auth and/or access profile coverage.";
    } else if (!managerHrId && !isManagerOptionalHrId(hrId)) {
      healthStatus = "missing_manager";
      reason = "Active employee is missing manager_hr_id.";
    } else if (normalizedManagerHrId && !employeeByHrId.has(normalizedManagerHrId)) {
      healthStatus = "manager_not_found";
      reason = "Active employee references a manager HR ID that was not found.";
    } else if (!rowText(employee, "jobTitle") && !rowText(employee, "job_title") && !rowText(employee, "positionTitle")) {
      healthStatus = "missing_job_title";
      reason = "Active employee is missing job title or position title.";
    } else if (rowNumber(employee, "lineId") === null && rowNumber(employee, "line_id") === null) {
      healthStatus = "missing_line";
      reason = "Active employee is missing line ownership.";
    } else if (rowNumber(employee, "areaId") === null && rowNumber(employee, "area_id") === null) {
      healthStatus = "missing_area";
      reason = "Active employee is missing area ownership.";
    }

    if (healthStatus !== "ok") {
      employeeIssues.push({
        full_name: rowText(employee, "displayName") ?? rowText(employee, "display_name") ?? rowText(employee, "fullName") ?? rowText(employee, "full_name") ?? "Unknown employee",
        has_access_profile: hasAccessProfile,
        has_auth_user: hasAuthUser,
        health_status: healthStatus,
        hr_id: hrId,
        job_title: rowText(employee, "jobTitle") ?? rowText(employee, "job_title") ?? rowText(employee, "positionTitle") ?? "",
        manager_hr_id: managerHrId,
        node_type: node.node_type,
        reason,
      });
    }
  }

  const health = computeEmployeeHealth({ gradedHrIds, issueHrIds: employeeIssues.map((issue) => issue.hr_id) });

  const attendanceMappingSummary = attendanceMappings
    ? summarizeDeviceUserMappings(
        attendanceMappings.map((row) => ({
          employeeHrId: rowText(row, "employee_hr_id"),
          isActive: row.is_active !== false,
          // Without this an identified driver or guard keeps counting as a missing mapping, which
          // is the whole defect this column exists to close.
          nonEmployeeLabel: rowText(row, "non_employee_label"),
        })),
      )
    : null;
  const businessVacationRows = vacationRows
    ? vacationRows.filter((row) => !isDisposableFixtureText(rowText(row, "employee_hr_id")))
    : null;
  const leaveMetrics = businessVacationRows
    ? buildVacationPlatformMetrics(
        businessVacationRows
          .map((row) => ({
            durationDays: rowNumber(row, "duration_days") ?? 0,
            managerDecision: rowText(row, "manager_decision") === "approved" || rowText(row, "manager_decision") === "rejected"
              ? rowText(row, "manager_decision") as "approved" | "rejected"
              : null,
            paymentStatus: rowText(row, "payment_status") === "paid" ? "paid" : "unpaid",
            status:
              rowText(row, "status") === "approved" || rowText(row, "status") === "rejected" || rowText(row, "status") === "pending_manager"
                ? rowText(row, "status") as "approved" | "rejected" | "pending_manager"
                : "pending_manager",
          })),
      )
    : null;

  return {
    summary: {
      activeEmployees: sharedWorkforce.activeEmployees,
      // "0 of 0 device users mapped" is not 100% ready — it is a table nobody filled.
      attendanceMappingIssues: attendanceMappingSummary ? attendanceMappingSummary.unmapped : null,
      attendanceReadinessRate: attendanceMappingSummary && attendanceMappingSummary.total > 0 ? attendanceMappingSummary.readinessRate : null,
      gradedEmployees: health.gradedEmployees,
      healthRate: accessReadable ? health.healthRate : null,
      healthyEmployees: accessReadable ? health.healthyEmployees : null,
      leaveApprovedRequests: leaveMetrics ? leaveMetrics.approvedRequests : null,
      leavePendingRequests: leaveMetrics ? leaveMetrics.pendingRequests : null,
      leaveRejectedRequests: leaveMetrics ? leaveMetrics.rejectedRequests : null,
      structureNodes: sharedWorkforce.totalStructure,
      totalEmployees: sharedWorkforce.totalEmployees,
      vacantPositions: sharedWorkforce.openVacancies,
    },
    employeeIssues,
    unavailable,
  };
}

const getDataHealthStatsCached = unstable_cache(
  async (): Promise<DataHealthStats> => {
    const stats = await getDataHealthStatsUncached();
    // A source that could not be read is named in `unavailable` and its figures left null. Right for
    // this render; kept, it would blank those figures for the next two minutes. Served, never kept.
    if (stats.unavailable.length > 0) {
      serveWithoutCaching(stats, `data health could not read: ${stats.unavailable.join(", ")}`);
    }
    return stats;
  },
  ["data-health-stats-v2"],
  { revalidate: DATA_HEALTH_STATS_CACHE_TTL_SECONDS },
);

export function getDataHealthStats(): Promise<DataHealthStats> {
  return unwrapServedWithoutCaching(getDataHealthStatsCached());
}
