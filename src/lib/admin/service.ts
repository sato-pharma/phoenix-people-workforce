import { unstable_cache } from "next/cache.js";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fetchAllRows } from "@/lib/supabase/paginated";
import {
  buildSalesOwnershipContext,
  classifyEmployeeNode,
  classifySalesOwnership,
  salesOwnershipLabel,
  shouldFlagMissingAccessForEmployeeNode,
  type EmployeeNodeInput,
  type EmployeeNodeType,
  type SalesOwnershipClassification,
  type SalesOwnershipRecord,
  type SalesOwnershipVacancySignal,
} from "@/lib/workforce-classification";
import { getEmployeeDirectory } from "@/lib/employees/employee-directory";
import { isDisposableFixtureText, isDisposableSalesRecordRow } from "@/lib/fixture-hygiene";
import { isManagerOptionalHrId } from "@/lib/employees/hierarchy-governance";
import {
  getOperationalMonitoringStats,
  type AdminMonitoringStats,
  type MonitoringSecurityEventsRequest,
} from "@/lib/operations/events";
import { summarizeDeviceUserMappings } from "@/lib/attendance/metrics";
import { buildVacationPlatformMetrics } from "@/lib/vacation/metrics";
import { getWorkforceMetrics } from "@/lib/platform/metrics";
import { systemAccessContext, type AccessContext } from "@/lib/auth/permissions";
import { getPayrollExpenseMetrics } from "@/lib/outstation/expenses";

export type PhoenixAdminStats = {
  totalEmployees: number;
  activeEmployees: number;
  payrollEligible: number;
  salaryRecords: number;
  salesRecords: number;
  expensesCount: number;
  salaryFlags: number;
  dataHealthIssues: number;
  vacancies: number;
  offers: number;
  auditLogs: Array<{
    action: string;
    entity_name: string;
    user_email: string;
    created_at: string | null;
  }>;
};

export async function getPhoenixAdminStats(): Promise<PhoenixAdminStats> {
  const supabase = getSupabaseAdmin();

  const [
    employees,
    active,
    payrollEligible,
    salaryRecords,
    salesRecords,
    expenses,
    salaryFlags,
    vacancies,
    offers,
    auditLogs
  ] = await Promise.all([
    supabase.from("employees").select("*", { count: "exact", head: true }),
    supabase.from("v_active_organogram").select("*", { count: "exact", head: true }),
    supabase.from("v_payroll_eligible_employees").select("*", { count: "exact", head: true }),
    supabase.from("salary_records").select("*", { count: "exact", head: true }),
    supabase.from("sales_records").select("*", { count: "exact", head: true }),
    supabase.from("payroll_expenses").select("*", { count: "exact", head: true }),
    supabase.from("salary_flags").select("*", { count: "exact", head: true }),
    supabase.from("position_vacancies").select("*", { count: "exact", head: true }),
    supabase.from("job_offers").select("*", { count: "exact", head: true }),
    supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(10)
  ]);
  const [dataHealthStats, expenseMetrics] = await Promise.all([
    getDataHealthStats().catch(() => null),
    getPayrollExpenseMetrics(systemAccessContext).catch(() => null),
  ]);

  return {
    totalEmployees: dataHealthStats?.summary.totalEmployees ?? employees.count ?? 0,
    activeEmployees: dataHealthStats?.summary.activeEmployees ?? active.count ?? 0,
    payrollEligible: payrollEligible.count ?? 0,
    salaryRecords: salaryRecords.count ?? 0,
    salesRecords: salesRecords.count ?? 0,
    expensesCount: expenseMetrics?.totalRows ?? expenses.count ?? 0,
    salaryFlags: salaryFlags.count ?? 0,
    dataHealthIssues: dataHealthStats?.summary.issuesCount ?? 0,
    vacancies: vacancies.count ?? 0,
    offers: offers.count ?? 0,
    auditLogs: (auditLogs.data ?? []).map((log) => ({
      action: log.summary ?? log.entity_type ?? "System activity",
      entity_name: log.entity_type
        ? `${log.entity_type}${log.entity_id ? ` #${log.entity_id}` : ""}`
        : "System",
      user_email: log.actor_login_id ?? "System",
      created_at: log.created_at ?? null,
    }))
  };
}

export async function getAdminMonitoringStats(
  eventRequest: MonitoringSecurityEventsRequest = {},
): Promise<AdminMonitoringStats> {
  return getOperationalMonitoringStats(eventRequest);
}

export type DataHealthStats = {
  summary: {
    totalEmployees: number;
    structureNodes: number;
    activeEmployees: number;
    healthyEmployees: number;
    issuesCount: number;
    healthRate: number;
    activeEmployeesMissingAuthAccess: number;
    nonLoginAggregationNodes: number;
    historicalRecords: number;
    vacancyNodes: number;
    vacantPositions: number;
    employeeLinkageWarnings: number;
    attendanceMappingIssues: number;
    attendanceReadinessRate: number;
    leaveApprovedRequests: number;
    leavePendingRequests: number;
    leaveRejectedRequests: number;
    unresolvedSalesExceptions: number;
    marketingPharmacyCoverageRate: number;
    marketingUnmappedPharmacyTargets: number;
  };
  salesClassification: Record<SalesOwnershipClassification, {
    label: string;
    records: number;
    salesValue: number;
  }>;
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
  salesIssues: Array<{
    record_id: string | null;
    batch_id: string | null;
    row_number: number | null;
    employee_hr_id: string | null;
    manager_hr_id: string | null;
    line: string | null;
    territory: string | null;
    product: string;
    sales_value: number;
    classification: SalesOwnershipClassification;
    linkage_health_status: string;
    reason: string;
  }>;
  orphanAudit: Array<{
    source: string;
    hr_id: string;
    rows_count: number;
    sample_name: string | null;
  }>;
  vacancyAudit: Array<{
    vacancy_id: string | null;
    vacancy_code: string | null;
    area_name: string | null;
    line_name: string | null;
    manager_hr_id: string | null;
    status: string | null;
  }>;
};

export type SalaryFlag = {
  id: string;
  hrId: string | null;
  flagType: string | null;
  severity: string | null;
  message: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
};

export type SalaryFlagsResult = {
  flags: SalaryFlag[];
  total: number;
  unresolvedCount: number;
};

export async function getSalaryFlags(showResolved = false): Promise<SalaryFlagsResult> {
  const supabase = getSupabaseAdmin();

  let query = supabase
    .from("salary_flags")
    .select("id, hr_id, flag_type, severity, message, resolved_at, resolved_by, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .limit(500);

  if (!showResolved) {
    query = query.is("resolved_at", null);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const unresolvedResult = showResolved
    ? await supabase.from("salary_flags").select("*", { count: "exact", head: true }).is("resolved_at", null)
    : null;

  const flags: SalaryFlag[] = (data ?? []).map((row: Record<string, unknown>) => ({
    id: row.id as string,
    hrId: (row.hr_id as string | null) ?? null,
    flagType: (row.flag_type as string | null) ?? null,
    severity: (row.severity as string | null) ?? null,
    message: (row.message as string | null) ?? null,
    resolvedAt: (row.resolved_at as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    createdAt: row.created_at as string,
  }));

  return {
    flags,
    total: count ?? 0,
    unresolvedCount: showResolved ? (unresolvedResult?.count ?? 0) : (count ?? 0),
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

const salesOwnershipClassifications: SalesOwnershipClassification[] = [
  "assigned_employee_sales",
  "vacant_territory_sales",
  "non_assignable_territory_sales",
  "line_level_sales",
  "others_unassigned_sales",
  "unresolved_sales_exception",
];

const dataHealthAccessContext: AccessContext = {
  hrId: "DATA_HEALTH_SYSTEM",
  loginId: "data-health.system",
  role: "Super Admin",
  scope: "system",
  source: "system",
};
// The full governance audit scans every sales_records row to build the classification
// breakdown, so it is intentionally heavy (it only runs on /admin/data-health now that
// the Command Center derives its summary cheaply). A longer cache keeps repeat visits
// instant without staling the audit meaningfully — it is a read-only review surface.
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

function relationName(value: unknown, key: string) {
  const source = Array.isArray(value) ? value[0] : value;
  if (!source || typeof source !== "object") return null;
  return rowText(source as Record<string, unknown>, key);
}

function emptySalesClassificationSummary(): DataHealthStats["salesClassification"] {
  return Object.fromEntries(
    salesOwnershipClassifications.map((classification) => [
      classification,
      {
        label: salesOwnershipLabel(classification),
        records: 0,
        salesValue: 0,
      },
    ]),
  ) as DataHealthStats["salesClassification"];
}

function addLineLookup(map: Map<string, number>, name: string | null | undefined, id: number | null | undefined) {
  if (!name || typeof id !== "number") return;
  map.set(normalizeHealthKey(name), id);
}

function employeeToNodeInput(employee: Awaited<ReturnType<typeof getEmployeeDirectory>>["employees"][number]): EmployeeNodeInput {
  return {
    areaId: employee.areaId,
    areaName: employee.areaName,
    crmId: employee.crmId,
    crmUsername: employee.crmUsername,
    employmentStatus: employee.employmentStatus,
    fullName: employee.fullName,
    hrId: employee.hrId,
    jobTitle: employee.jobTitle,
    lineId: employee.lineId,
    lineName: employee.lineName,
    managerHrId: employee.managerHrId,
    positionTitle: employee.positionTitle,
    workEmail: employee.workEmail,
  };
}

function vacancySignalFromRow(row: Record<string, unknown>): SalesOwnershipVacancySignal {
  return {
    areaId: rowNumber(row, "area_id"),
    areaName: relationName(row.areas, "name"),
    lineId: rowNumber(row, "line_id"),
    lineName: relationName(row.lines, "name"),
    managerHrId: rowText(row, "manager_hr_id"),
    status: rowText(row, "status"),
    vacancyCode: rowText(row, "vacancy_code"),
    vacancyId: rowText(row, "id"),
  };
}

function salesOwnershipRecordFromRow(row: Record<string, unknown>): SalesOwnershipRecord {
  return {
    employeeCrmId: rowText(row, "employee_crm_id"),
    employeeHrId: rowText(row, "employee_hr_id"),
    employeeLookupKey: rowText(row, "employee_lookup_key"),
    employeeName: rowText(row, "employee_name"),
    line: rowText(row, "line"),
    managerHrId: rowText(row, "manager_hr_id"),
    territory: rowText(row, "territory"),
  };
}

async function getDataHealthStatsUncached(): Promise<DataHealthStats> {
  const supabase = getSupabaseAdmin();

  const [
    directory,
    appAuthUsers,
    accessProfiles,
    salesRows,
    vacancyRows,
    attendanceMappings,
    vacationRows,
    orphanAudit,
  ] = await Promise.all([
    getEmployeeDirectory(),
    fetchAllRows<Record<string, unknown>>(() =>
      supabase.from("app_auth_users").select("hr_id,is_active,login_id"),
    ),
    fetchAllRows<Record<string, unknown>>(() =>
      supabase.from("user_access_profiles").select("hr_id,is_active,auth_user_id,login_id"),
    ),
    fetchAllRows<Record<string, unknown>>(() =>
      supabase
        .from("sales_records")
        .select("id,batch_id,row_number,employee_hr_id,employee_crm_id,employee_lookup_key,employee_name,manager_hr_id,line,territory,product,sales_value,validation_state,month,year"),
    ),
    fetchAllRows<Record<string, unknown>>(() =>
      supabase
        .from("position_vacancies")
        .select("id,vacancy_code,area_id,line_id,manager_hr_id,status,areas(name),lines(name)"),
    ),
    fetchAllRows<Record<string, unknown>>(() =>
      supabase
        .from("attendance_device_user_map")
        .select("employee_hr_id,is_active"),
    ),
    fetchAllRows<Record<string, unknown>>(() =>
      supabase
        .from("v2_vacation_requests")
        .select("employee_hr_id,status,payment_status,duration_days,manager_decision"),
    ).catch(() => []),
    supabase.from("v_hr_id_orphan_audit").select("*"),
  ]);

  const businessEmployees = directory.employees.filter((employee) =>
    !isDisposableFixtureText(employee.hrId) && !isDisposableFixtureText(employee.fullName),
  );
  const businessSalesRows = salesRows.filter((row) => !isDisposableSalesRecordRow(row));
  const businessVacancyRows = vacancyRows.filter((row) => !isDisposableFixtureText(rowText(row, "vacancy_code")));
  const businessVacationRows = vacationRows.filter((row) => !isDisposableFixtureText(rowText(row, "employee_hr_id")));

  const employeeNodes = businessEmployees.map(employeeToNodeInput);
  const authHrIds = new Set(
    appAuthUsers
      .filter((row) => row.is_active !== false)
      .map((row) => normalizeHealthKey(row.hr_id))
      .filter(Boolean),
  );
  const accessProfileHrIds = new Set(
    accessProfiles
      .filter((row) => row.is_active !== false)
      .map((row) => normalizeHealthKey(row.hr_id))
      .filter(Boolean),
  );
  const employeeByHrId = new Map(employeeNodes.map((employee) => [normalizeHealthKey(employee.hrId), employee]));
  const lineIdByName = new Map<string, number>();
  const areaIdByName = new Map<string, number>();
  const lineIdByAreaId = new Map<number, number>();

  for (const line of directory.lookups.lines) {
    const id = Number(line.value);
    if (Number.isFinite(id)) addLineLookup(lineIdByName, line.label, id);
  }
  for (const area of directory.lookups.areas) {
    const areaId = Number(area.value);
    if (Number.isFinite(areaId)) {
      areaIdByName.set(normalizeHealthKey(area.label), areaId);
      if (typeof area.lineId === "number") lineIdByAreaId.set(areaId, area.lineId);
    }
  }
  for (const employee of businessEmployees) {
    addLineLookup(lineIdByName, employee.lineName, employee.lineId);
    if (employee.areaName && typeof employee.areaId === "number") areaIdByName.set(normalizeHealthKey(employee.areaName), employee.areaId);
    if (typeof employee.areaId === "number" && typeof employee.lineId === "number") lineIdByAreaId.set(employee.areaId, employee.lineId);
  }

  const openVacancyRows = businessVacancyRows.filter((row) => rowText(row, "status") === "open");

  const ownershipContext = buildSalesOwnershipContext({
    areaIdByName,
    employees: employeeNodes,
    lineIdByAreaId,
    lineIdByName,
    vacancies: openVacancyRows.map(vacancySignalFromRow),
  });

  const employeeIssues: DataHealthStats["employeeIssues"] = [];
  let historicalRecords = 0;
  let vacancyNodes = 0;
  let nonLoginAggregationNodes = 0;

  for (const employee of employeeNodes) {
    const node = classifyEmployeeNode(employee);
    if (node.node_type === "historical_record") historicalRecords += 1;
    if (node.node_type === "vacancy_node") vacancyNodes += 1;
    if (
      node.node_type === "system_placeholder" ||
      node.node_type === "others_unassigned_node" ||
      node.node_type === "non_login_aggregation_node"
    ) {
      nonLoginAggregationNodes += 1;
    }

    if (!node.eligible_for_login) continue;

    const hrId = rowText(employee, "hrId") ?? rowText(employee, "hr_id") ?? "";
    const normalizedHrId = normalizeHealthKey(hrId);
    const hasAuthUser = authHrIds.has(normalizedHrId);
    const hasAccessProfile = accessProfileHrIds.has(normalizedHrId);
    const managerHrId = rowText(employee, "managerHrId") ?? rowText(employee, "manager_hr_id");
    const normalizedManagerHrId = normalizeHealthKey(managerHrId);

    let healthStatus = "ok";
    let reason = "Active employee access and linkage are classified.";

    if (shouldFlagMissingAccessForEmployeeNode(employee, { hasAccessProfile, hasAuthUser })) {
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
        full_name: rowText(employee, "fullName") ?? rowText(employee, "full_name") ?? "Unknown employee",
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

  const salesClassification = emptySalesClassificationSummary();
  const salesIssues: DataHealthStats["salesIssues"] = [];

  for (const row of businessSalesRows) {
    const ownership = classifySalesOwnership(salesOwnershipRecordFromRow(row), ownershipContext);
    const salesValue = rowNumber(row, "sales_value") ?? 0;
    salesClassification[ownership.classification].records += 1;
    salesClassification[ownership.classification].salesValue += salesValue;

    if (ownership.classification === "unresolved_sales_exception") {
      salesIssues.push({
        record_id: rowText(row, "id"),
        batch_id: rowText(row, "batch_id"),
        classification: ownership.classification,
        employee_hr_id: rowText(row, "employee_hr_id"),
        line: rowText(row, "line"),
        linkage_health_status: ownership.classification,
        manager_hr_id: rowText(row, "manager_hr_id"),
        product: rowText(row, "product") ?? "Unknown",
        reason: ownership.reason,
        row_number: rowNumber(row, "row_number"),
        sales_value: salesValue,
        territory: rowText(row, "territory"),
      });
    }
  }

  const activeEmployeesMissingAuthAccess = employeeIssues.filter((issue) =>
    ["missing_auth_access", "missing_auth_user", "missing_access_profile"].includes(issue.health_status),
  ).length;
  const employeeLinkageWarnings = employeeIssues.length - activeEmployeesMissingAuthAccess;
  const issuesCount = employeeIssues.length + salesIssues.length;
  const attendanceMappingSummary = summarizeDeviceUserMappings(
    attendanceMappings.map((row) => ({
      employeeHrId: rowText(row, "employee_hr_id"),
      isActive: row.is_active !== false,
    })),
  );
  const leaveMetrics = buildVacationPlatformMetrics(
    businessVacationRows.map((row) => ({
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
  );
  const sharedWorkforce = await getWorkforceMetrics(dataHealthAccessContext);
  const sharedActiveEmployees = sharedWorkforce.activeEmployees;
  const healthyEmployees = Math.max(0, sharedActiveEmployees - employeeIssues.length);
  const healthRate = sharedActiveEmployees > 0 ? (healthyEmployees / sharedActiveEmployees) * 100 : 100;
  const orphans = (Array.isArray(orphanAudit.data) ? orphanAudit.data : [])
    .filter((row) => !isDisposableFixtureText(rowText(row as Record<string, unknown>, "hr_id")));
  const vacancyAudit = openVacancyRows.map((row) => ({
    area_name: relationName(row.areas, "name"),
    line_name: relationName(row.lines, "name"),
    manager_hr_id: rowText(row, "manager_hr_id"),
    status: rowText(row, "status"),
    vacancy_code: rowText(row, "vacancy_code"),
    vacancy_id: rowText(row, "id"),
  }));
  // Marketing-request pharmacy -> brick/region mapping coverage (best-effort; never breaks the page).
  let marketingPharmacyCoverageRate = 100;
  let marketingUnmappedPharmacyTargets = 0;
  try {
    const coverage = await supabase.rpc("phx_marketing_pharmacy_mapping_coverage");
    if (!coverage.error) {
      const row = (Array.isArray(coverage.data) ? coverage.data[0] : null) as
        { total_targets?: number; mapped_targets?: number } | null;
      const total = Number(row?.total_targets ?? 0);
      const mapped = Number(row?.mapped_targets ?? 0);
      marketingUnmappedPharmacyTargets = Math.max(0, total - mapped);
      marketingPharmacyCoverageRate = total > 0 ? (mapped / total) * 100 : 100;
    }
  } catch {
    // RPC unavailable (e.g. fresh DB) — keep the safe defaults.
  }

  const result: DataHealthStats = {
    summary: {
      activeEmployees: sharedActiveEmployees,
      activeEmployeesMissingAuthAccess,
      attendanceMappingIssues: attendanceMappingSummary.unmapped,
      attendanceReadinessRate: attendanceMappingSummary.readinessRate,
      employeeLinkageWarnings,
      healthRate,
      healthyEmployees,
      historicalRecords,
      issuesCount,
      leaveApprovedRequests: leaveMetrics.approvedRequests,
      leavePendingRequests: leaveMetrics.pendingRequests,
      leaveRejectedRequests: leaveMetrics.rejectedRequests,
      marketingPharmacyCoverageRate,
      marketingUnmappedPharmacyTargets,
      nonLoginAggregationNodes,
      structureNodes: sharedWorkforce.totalStructure,
      totalEmployees: sharedWorkforce.totalEmployees,
      unresolvedSalesExceptions: salesIssues.length,
      vacantPositions: sharedWorkforce.openVacancies,
      vacancyNodes,
    },
    employeeIssues,
    salesClassification,
    salesIssues,
    orphanAudit: orphans,
    vacancyAudit,
  };
  return result;
}

export const getDataHealthStats = unstable_cache(
  getDataHealthStatsUncached,
  ["data-health-stats"],
  { revalidate: DATA_HEALTH_STATS_CACHE_TTL_SECONDS },
);
