import type { AccessContext } from "@/lib/auth/permissions";
import { getDataHealthStats, getSalaryFlags, type DataHealthStats } from "@/lib/admin/service";
import { getAttendanceIngestionHealth } from "@/lib/attendance/ingestion-health";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getVacationReportData } from "@/lib/vacation/service";
import { getEmployeeDirectory, type EmployeeDirectoryData } from "@/lib/employees/employee-directory";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import { canonicalHrIdKey } from "@/lib/hr-id";
import { buildLifecycleRiskMetrics } from "@/lib/lifecycle-risk/metrics";
import { getOperationalRecentActivity, type OperationalActivitySummary } from "@/lib/operations/events";
import { getPayrollExpenseMetrics } from "@/lib/outstation/expenses";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { countUnoccupiedWorkforceSeats, getPlatformMetrics, type UncomputedRate } from "@/lib/platform/metrics";
import { getProbationRows } from "@/lib/probation/service";
import { getSalesPlatformMetrics } from "@/lib/sales/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { calculateWorkforceStructureSummary } from "@/lib/workforce/seat-lifecycle";

// `loadDirectManagerName` lived here until 2026-08-30. Its only caller was the Admin Command
// Center's welcome hero, retired with that page; git has it if a future hero wants the same
// lookup. The REST of this module stays and is not dead: `getAdminCommandCenterData` is what the
// payroll reconciliation check compares its own figures against
// (src/lib/reconciliation/checks/payroll.ts) and what four phase-smoke scripts call. It is now a
// pure aggregate with no page behind it, which is why its `showFinancialModules` / `showAdminModules`
// flags are hardcoded `true` — they were the RETIRED page's display gates, and every remaining
// caller passes a system-scope context that would set them true anyway.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * `null` on any figure means its source could not be read — and the reason is named in
 * `AdminCommandCenterData.dataUnavailable`. A reader shows "Unavailable", never 0 or 100%.
 */
export type DataHealthMetrics = {
  attendanceMappingIssues: number | null;
  attendanceReadinessRate: UncomputedRate;
  leaveApprovedRequests: number | null;
  leavePendingRequests: number | null;
  leaveRejectedRequests: number | null;
  employeeHealthRate: number | null;
  healthyEmployees: number | null;
  totalEmployees: number;
  totalStructure: number;
  vacantPositions: number;
  missingManager: number;
  missingJobTitle: number;
  salesLinkageRate: number;
  salesLinkageBatch: string | null;
};

/**
 * Flat company snapshot — avoids OverviewDashboardData entirely.
 *
 * No page renders this any more: the Admin Command Center that did was retired on 2026-08-30.
 * It survives as a DATA shape, read by the payroll reconciliation check and the phase-smoke
 * scripts. The `access` flags below are therefore vestigial display gates — see the note at the
 * top of this file before wiring them to anything.
 */
export type AdminCommandCenterData = {
  access: {
    showAdminModules: boolean;
    showFinancialModules: boolean;
  };
  overview: {
    hr: {
      activeEmployees: number;
      totalEmployees: number;
      totalStructure: number;
      vacantPositions: number;
      uniqueLines: number;
      uniqueAreas: number;
      employeesWithoutManagers: number;
    };
    payroll: {
      batchLabel: string;
      employees: number;
      gross: number;
      net: number;
      flags: number;
    };
    sales: {
      salesValue: number;
      targetValue: number;
      achievementRate: UncomputedRate;
      activeProducts: number;
    };
    expenses: {
      approvedAmount: number;
      totalAmount: number;
      totalRows: number;
      reportCount: number;
    };
    risk: {
      expiringContracts: number;
      probationEndings: number;
    };
    leave: {
      approvedRequests: number;
      managerDecisionActions: number;
      paidDays: number;
      pendingRequests: number;
      rejectedRequests: number;
      totalRequests: number;
      unpaidDays: number;
    };
    attendance: {
      activeMappings: number;
      activePolicies: number;
      currentMonthWorkingDays: number;
      mappingReadinessRate: UncomputedRate;
      missingDeviceMappings: number;
      policyCoverageRate: UncomputedRate;
      totalDeviceMappings: number;
      totalPolicies: number;
    };
    /** Fingerprint-agent ingestion freshness; null when the check itself failed. */
    attendanceAgent: {
      lastIngestedAt: string | null;
      lastIngestedLabel: string;
      missedWorkingDays: number;
      status: "healthy" | "warning" | "attention";
    } | null;
    // Executive attention signals (P1/P2): forward-looking risk the CEO must see at a glance.
    executive: {
      pendingResignations: number;
      totalResignations: number;
      /** Rolling 30-day departures ÷ active headcount, as a percentage. */
      attritionRate30d: number;
      /** Probation reviews with 1–30 days remaining (decision imminent). */
      criticalProbation: number;
      /** Contract renewals falling due within the next 7 days. */
      contractsDueSoon: number;
      /** Company-wide average coaching score (0–100) across recent completed reports. */
      coachingScore: number;
      /** Reps in the critical/red coaching zones. */
      coachingRedZone: number;
      /** Vacation requests that have breached the manager/HR approval SLA. */
      overdueLeaveSla: number;
    };
  };
  health: DataHealthMetrics;
  operations: OperationalActivitySummary;
  payrollEligibleCount: number;
  /** Open (unresolved) salary flags — financial-gated; 0 when not authorized. */
  unresolvedSalaryFlags: number;
  dataUnavailable: string[];
  /** ISO timestamp of when this snapshot was built (server-side), for the "data as of" label. */
  generatedAt: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function readAllRows<T = Record<string, unknown>>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildQuery: () => any,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const pageRows = (Array.isArray(data) ? data : []) as T[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
    offset += pageSize;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Data health queries (uses Supabase JS client — safe)
// ---------------------------------------------------------------------------

// Linkage against SoS Monthly Closing. This used to run two `count(*)` queries over
// `sales_records` filtered on `link_status` — a health score for a table nothing reads, sitting
// next to a "Fix" link that opened the (since retired) Data Health page, which reported on the
// canonical rows. The card and its own drill-down would have disagreed.
async function fetchSalesHealthCounts(accessContext: AccessContext): Promise<{
  error: string | null;
  linkedRows: number;
  totalRows: number;
}> {
  try {
    const sales = await getSalesPlatformMetrics(accessContext);
    return { error: null, linkedRows: sales.linkedRecords, totalRows: sales.totalRecords };
  } catch {
    return { error: "Sales linkage data unavailable.", linkedRows: 0, totalRows: 0 };
  }
}

function buildDataHealth(
  directory: EmployeeDirectoryData | null,
  salesCounts: { linkedRows: number; totalRows: number },
): DataHealthMetrics {
  const employees = directory?.employees ?? [];
  const activeEmployees = employees.filter((employee) =>
    ["active", "on_leave"].includes(String(employee.employmentStatus ?? "").trim().toLowerCase())
  );
  const missingManager = activeEmployees.filter(isMissingRequiredManager).length;
  const missingJobTitle = activeEmployees.filter((employee) => !employee.jobTitle && !employee.positionTitle).length;
  const healthyEmployees = Math.max(0, activeEmployees.length - missingManager - missingJobTitle);
  const employeeHealthRate = activeEmployees.length > 0 ? (healthyEmployees / activeEmployees.length) * 100 : 100;
  const salesLinkageRate = salesCounts.totalRows > 0 ? (salesCounts.linkedRows / salesCounts.totalRows) * 100 : 100;
  const workforceStructure = calculateWorkforceStructureSummary({
    activeEmployees: activeEmployees.length,
    // Seats, not position_vacancies rows: the raw row count double-counts a seat
    // that emptied more than once and keeps stale rows on seats an active
    // employee already fills, so this card used to read 45 where the Organogram
    // read 33. countUnoccupiedWorkforceSeats is the one place that rule lives.
    openVacancies: directory
      ? countUnoccupiedWorkforceSeats({
          employees: activeEmployees,
          vacancies: directory.lookups.workforceVacancies,
        })
      : 0,
  });

  return {
    // `null`, never 0 or 1. This builder reads no attendance or leave data at all, and the old
    // literals claimed a perfect fingerprint-mapping score and an empty leave queue off queries that
    // were never run.
    attendanceMappingIssues: null,
    attendanceReadinessRate: null,
    leaveApprovedRequests: null,
    leavePendingRequests: null,
    leaveRejectedRequests: null,
    employeeHealthRate,
    healthyEmployees,
    missingJobTitle,
    missingManager,
    salesLinkageBatch: null,
    salesLinkageRate,
    totalEmployees: workforceStructure.activeEmployees,
    totalStructure: workforceStructure.totalStructure,
    vacantPositions: workforceStructure.openVacancies,
  };
}

function buildDataHealthFromStats(
  stats: DataHealthStats,
  salesCounts: { linkedRows: number; totalRows: number },
): DataHealthMetrics {
  const missingManager = stats.employeeIssues.filter((issue) => issue.health_status === "missing_manager").length;
  const missingJobTitle = stats.employeeIssues.filter((issue) => issue.health_status === "missing_job_title").length;
  const salesLinkageRate = salesCounts.totalRows > 0 ? (salesCounts.linkedRows / salesCounts.totalRows) * 100 : 100;

  return {
    attendanceMappingIssues: stats.summary.attendanceMappingIssues,
    attendanceReadinessRate: stats.summary.attendanceReadinessRate,
    leaveApprovedRequests: stats.summary.leaveApprovedRequests,
    leavePendingRequests: stats.summary.leavePendingRequests,
    leaveRejectedRequests: stats.summary.leaveRejectedRequests,
    employeeHealthRate: stats.summary.healthRate,
    healthyEmployees: stats.summary.healthyEmployees,
    missingJobTitle,
    missingManager,
    salesLinkageBatch: null,
    salesLinkageRate,
    totalEmployees: stats.summary.activeEmployees,
    totalStructure: stats.summary.structureNodes,
    vacantPositions: stats.summary.vacantPositions,
  };
}

// Lightweight health summary for the Command Center, derived from the cheap platform metrics +
// sales linkage counts it already fetches — so it never pays for the workforce-health audit
// (getDataHealthStats), which grades every employee record one by one.
function buildDataHealthFromMetrics(
  platformMetrics: Awaited<ReturnType<typeof getPlatformMetrics>>,
  salesCounts: { linkedRows: number; totalRows: number },
): DataHealthMetrics {
  const activeEmployees = platformMetrics.workforce.activeEmployees;
  const missingManager = platformMetrics.workforce.employeesWithoutManagers;
  const healthyEmployees = Math.max(0, activeEmployees - missingManager);
  const employeeHealthRate = activeEmployees > 0 ? (healthyEmployees / activeEmployees) * 100 : 100;
  const salesLinkageRate = salesCounts.totalRows > 0 ? (salesCounts.linkedRows / salesCounts.totalRows) * 100 : 100;

  return {
    attendanceMappingIssues: platformMetrics.attendance.missingDeviceMappings,
    attendanceReadinessRate: platformMetrics.attendance.mappingReadinessRate,
    leaveApprovedRequests: platformMetrics.leave.approvedRequests,
    leavePendingRequests: platformMetrics.leave.pendingRequests,
    leaveRejectedRequests: platformMetrics.leave.rejectedRequests,
    employeeHealthRate,
    healthyEmployees,
    missingJobTitle: 0,
    missingManager,
    salesLinkageBatch: null,
    salesLinkageRate,
    totalEmployees: activeEmployees,
    totalStructure: platformMetrics.workforce.totalStructure,
    vacantPositions: platformMetrics.workforce.openVacancies,
  };
}

async function fetchPayrollEligibleCount(): Promise<{ count: number; error: string | null }> {
  const supabase = getSupabaseAdmin();
  try {
    const { count, error } = await supabase
      .from("v_payroll_eligible_employees")
      .select("*", { count: "exact", head: true });
    if (error) throw error;
    return { count: count ?? 0, error: null };
  } catch {
    return { count: 0, error: "Payroll eligible count unavailable." };
  }
}

async function fetchPayrollSummary(): Promise<AdminCommandCenterData["overview"]["payroll"] & {
  batch: { month: number; year: number } | null;
  error: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const empty = { batch: null, batchLabel: "—", employees: 0, error: null, flags: 0, gross: 0, net: 0 };

  try {
    const { data: batch, error: batchError } = await supabase
      .from("salary_batches")
      .select("id,month,year")
      .lt("year", 2090)
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (batchError) throw batchError;
    if (!batch?.id) return empty;

    const batchId = String(batch.id);
    const [records, flagsResult] = await Promise.all([
      readAllRows<Record<string, unknown>>(() =>
        supabase
          .from("salary_records")
          .select("gross_salary,net_salary")
          .eq("batch_id", batchId),
      ),
      supabase
        .from("salary_flags")
        .select("*", { count: "exact", head: true })
        .eq("batch_id", batchId),
    ]);
    if (flagsResult.error) throw flagsResult.error;

    return {
      batch: {
        month: safeNumber(batch.month),
        year: safeNumber(batch.year),
      },
      batchLabel: `${safeNumber(batch.month)}/${safeNumber(batch.year)}`,
      employees: records.length,
      error: null,
      flags: flagsResult.count ?? 0,
      gross: records.reduce((sum, row) => sum + safeNumber(row.gross_salary), 0),
      net: records.reduce((sum, row) => sum + safeNumber(row.net_salary), 0),
    };
  } catch {
    return { ...empty, error: "Payroll data unavailable." };
  }
}

function canUseCompanyPayrollSummary(accessContext: AccessContext) {
  return (
    accessContext.scope === "system" ||
    accessContext.scope === "company" ||
    accessContext.role === "Super Admin" ||
    accessContext.role === "CEO" ||
    accessContext.role === "Finance Manager"
  );
}

async function fetchScopedPayrollSummary(accessContext: AccessContext): Promise<AdminCommandCenterData["overview"]["payroll"] & {
  batch: { month: number; year: number } | null;
  error: string | null;
}> {
  try {
    const dashboard = await getPayrollDashboard(undefined, accessContext);
    return {
      batch: dashboard.batch ? { month: dashboard.batch.month, year: dashboard.batch.year } : null,
      batchLabel: dashboard.batch ? `${dashboard.batch.month}/${dashboard.batch.year}` : "—",
      employees: dashboard.summary.totalEmployees,
      error: null,
      flags: dashboard.flags.length,
      gross: dashboard.summary.totalGross,
      net: dashboard.summary.totalNet,
    };
  } catch {
    return { batch: null, batchLabel: "—", employees: 0, error: "Payroll data unavailable.", flags: 0, gross: 0, net: 0 };
  }
}

async function fetchSalesSummary(accessContext: AccessContext): Promise<AdminCommandCenterData["overview"]["sales"] & { error: string | null }> {
  const empty = { achievementRate: null, activeProducts: 0, error: null, salesValue: 0, targetValue: 0 };

  try {
    return { ...await getSalesPlatformMetrics(accessContext), error: null };
  } catch {
    return { ...empty, error: "Sales data unavailable." };
  }
}

async function fetchExpenseSummary(accessContext: AccessContext): Promise<{
  approvedAmount: number;
  totalAmount: number;
  totalRows: number;
  reportCount: number;
  error: string | null;
}> {
  const empty = { approvedAmount: 0, totalAmount: 0, totalRows: 0, reportCount: 0, error: null };

  try {
    // Use the same unified historical + live outstation expense metrics as the dashboard.
    const metrics = await getPayrollExpenseMetrics(accessContext);

    return {
      approvedAmount: metrics.approvedAmount,
      totalAmount: metrics.totalAmount,
      totalRows: metrics.totalRows,
      reportCount: metrics.reportCount,
      error: null,
    };
  } catch {
    return { ...empty, error: "Expense data unavailable." };
  }
}

async function fetchRiskSummary(accessContext: AccessContext): Promise<{
  expiringContracts: number;
  probationEndings: number;
  error: string | null;
}> {
  const empty = { expiringContracts: 0, probationEndings: 0, error: null };

  try {
    const [contractResult, probations, directory] = await Promise.all([
      getContractRenewalDashboardData(accessContext),
      getProbationRows(accessContext),
      getEmployeeDirectory(),
    ]);
    const displayNameByHrId = new Map(
      directory.employees.map((employee) => [canonicalHrIdKey(employee.hrId), employee.displayName]),
    );
    const lifecycleRisk = buildLifecycleRiskMetrics({
      contracts: contractResult.rows.map((row) => ({
        contractRenewalDate: row.contract_renewal_date,
        employeeHrId: row.hr_id,
        employeeName: displayNameByHrId.get(canonicalHrIdKey(row.hr_id)) ?? row.full_name,
        workflowStatus: row.workflow?.status ?? null,
      })),
      probations: probations.map((row) => ({
        daysRemaining: row.days_remaining,
        employeeHrId: row.hr_id,
        employeeName: displayNameByHrId.get(canonicalHrIdKey(row.hr_id)) ?? row.full_name,
        hireDate: row.hire_date,
        probationEndDate: row.probation_end_date,
        workflowDecision: row.workflow?.decision ?? null,
      })),
    });
    return {
      expiringContracts: lifecycleRisk.expiringContracts,
      probationEndings: lifecycleRisk.probationEndings,
      error: null,
    };
  } catch {
    return { ...empty, error: "Risk data unavailable." };
  }
}

/**
 * Executive attention signals (P1). Each source is isolated: a failure records an
 * "Unavailable" string and leaves a 0 (never a misleading decision figure). The attrition
 * RATE is intentionally not computed here — the denominator (active headcount) is owned by
 * the caller, so we return the raw 30-day departure count and let each path divide.
 */
async function fetchExecutiveSignals(
  accessContext: AccessContext,
  options: { showFinancial: boolean },
): Promise<{
  pendingResignations: number;
  totalResignations: number;
  departuresLast30d: number;
  criticalProbation: number;
  contractsDueSoon: number;
  unresolvedSalaryFlags: number;
  coachingScore: number;
  coachingRedZone: number;
  overdueLeaveSla: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const daysFromNow = (iso: string | null | undefined): number | null => {
    if (!iso) return null;
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return null;
    return Math.floor((time - now) / dayMs);
  };

  const [
    resignationsResult,
    probationResult,
    contractsResult,
    salaryFlagsResult,
    coachingResult,
    leaveResult,
  ] = await Promise.allSettled([
    getResignationsDashboardData(accessContext),
    getProbationRows(accessContext),
    getContractRenewalDashboardData(accessContext),
    options.showFinancial ? getSalaryFlags() : Promise.resolve(null),
    getCoachingReports({}, accessContext),
    getVacationReportData(accessContext, {}),
  ]);

  let pendingResignations = 0;
  let totalResignations = 0;
  let departuresLast30d = 0;
  if (resignationsResult.status === "fulfilled") {
    const value = resignationsResult.value;
    pendingResignations = value.summary.pending;
    totalResignations = value.summary.total;
    // A departure counts when its effective (last working) date lands in the past 30 days.
    departuresLast30d = value.records.filter((record) => {
      const delta = daysFromNow(record.effectiveDate);
      return delta !== null && delta <= 0 && delta >= -30;
    }).length;
  } else {
    errors.push("Resignation data unavailable.");
  }

  let criticalProbation = 0;
  if (probationResult.status === "fulfilled") {
    criticalProbation = probationResult.value.filter(
      (row) => typeof row.days_remaining === "number" && row.days_remaining > 0 && row.days_remaining <= 30,
    ).length;
  } else {
    errors.push("Probation data unavailable.");
  }

  let contractsDueSoon = 0;
  if (contractsResult.status === "fulfilled") {
    contractsDueSoon = contractsResult.value.rows.filter((row) => {
      const delta = daysFromNow(row.contract_renewal_date);
      return delta !== null && delta >= 0 && delta <= 7;
    }).length;
  } else {
    errors.push("Contract renewal data unavailable.");
  }

  let unresolvedSalaryFlags = 0;
  if (options.showFinancial) {
    if (salaryFlagsResult.status === "fulfilled" && salaryFlagsResult.value) {
      unresolvedSalaryFlags = salaryFlagsResult.value.unresolvedCount;
    } else if (salaryFlagsResult.status === "rejected") {
      errors.push("Salary flag data unavailable.");
    }
  }

  // Coaching quality — company-wide average over recent completed reports (no per-rep filter).
  let coachingScore = 0;
  let coachingRedZone = 0;
  if (coachingResult.status === "fulfilled") {
    const analytics = buildCoachingReportAnalytics(coachingResult.value);
    if (analytics.coachingCount > 0) {
      coachingScore = analytics.averageScore;
      // PEOPLE, not reports — `zoneCounts` is a distribution over REPORTS, and summing its two red
      // buckets counted one rep coached red four times as four reps.
      coachingRedZone = analytics.redZoneRepCount;
    } else {
      // No completed reports yet — show "Unavailable" rather than a misleading 0%.
      errors.push("Coaching data unavailable.");
    }
  } else {
    errors.push("Coaching data unavailable.");
  }

  // Leave approval SLA breaches — already aggregated company-wide by the vacation dashboard.
  let overdueLeaveSla = 0;
  if (leaveResult.status === "fulfilled") {
    overdueLeaveSla = leaveResult.value.dashboard.overdueBySla.total;
  } else {
    errors.push("Leave SLA data unavailable.");
  }

  return {
    pendingResignations,
    totalResignations,
    departuresLast30d,
    criticalProbation,
    contractsDueSoon,
    unresolvedSalaryFlags,
    coachingScore,
    coachingRedZone,
    overdueLeaveSla,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function getAdminCommandCenterData(accessContext: AccessContext): Promise<AdminCommandCenterData> {
  const dataUnavailable: string[] = [];
  const showFinancialModules = true;
  const showAdminModules = showFinancialModules;
  const showSalesModules = true;
  const emptyOperations: OperationalActivitySummary = {
    failureCount24h: 0,
    lastEventAt: null,
    recent: [],
    staleSources: [],
    totalEvents24h: 0,
  };

  type ExecutiveSignals = Awaited<ReturnType<typeof fetchExecutiveSignals>>;
  const executiveSignalsPromise: Promise<ExecutiveSignals> = fetchExecutiveSignals(accessContext, { showFinancial: showFinancialModules })
    .catch(() => ({
      pendingResignations: 0,
      totalResignations: 0,
      departuresLast30d: 0,
      criticalProbation: 0,
      contractsDueSoon: 0,
      unresolvedSalaryFlags: 0,
      coachingScore: 0,
      coachingRedZone: 0,
      overdueLeaveSla: 0,
      errors: ["Executive signals unavailable."],
    }));
  let executiveSignals: ExecutiveSignals | null = null;

  // One single-row query + cached holiday lookups — cheap, shared by both load paths.
  const attendanceAgentPromise = getAttendanceIngestionHealth()
    .then((health) => ({
      lastIngestedAt: health.lastIngestedAt,
      lastIngestedLabel: health.lastIngestedLabel,
      missedWorkingDays: health.missedWorkingDays,
      status: health.status,
    }))
    .catch(() => null);

  try {
    const [executiveSignalsResult, platformMetrics, salesHealth, eligibleResult, operations, attendanceAgent] = await Promise.all([
      executiveSignalsPromise,
      getPlatformMetrics(accessContext),
      showSalesModules ? fetchSalesHealthCounts(accessContext) : Promise.resolve({ error: null, linkedRows: 0, totalRows: 0 }),
      showFinancialModules ? fetchPayrollEligibleCount() : Promise.resolve({ count: 0, error: null }),
      getOperationalRecentActivity(accessContext, { limit: 5 }),
      attendanceAgentPromise,
    ]);
    if (!attendanceAgent) dataUnavailable.push("Attendance agent health unavailable.");
    executiveSignals = executiveSignalsResult;
    dataUnavailable.push(...executiveSignals.errors);
    dataUnavailable.push(...platformMetrics.dataUnavailable);
    if (salesHealth.error) dataUnavailable.push(salesHealth.error);
    if (eligibleResult.error) dataUnavailable.push(eligibleResult.error);

    // Derived from the cheap metrics already loaded above — NOT the full governance audit, which
    // grades every record one by one and was the cause of the ~10s Command Center load.
    const health = buildDataHealthFromMetrics(platformMetrics, salesHealth);

    const overview = {
      attendanceAgent,
      attendance: {
        activeMappings: platformMetrics.attendance.activeMappings,
        activePolicies: platformMetrics.attendance.activePolicies,
        currentMonthWorkingDays: platformMetrics.attendance.currentMonthWorkingDays,
        mappingReadinessRate: platformMetrics.attendance.mappingReadinessRate,
        missingDeviceMappings: platformMetrics.attendance.missingDeviceMappings,
        policyCoverageRate: platformMetrics.attendance.policyCoverageRate,
        totalDeviceMappings: platformMetrics.attendance.totalDeviceMappings,
        totalPolicies: platformMetrics.attendance.totalPolicies,
      },
      expenses: showFinancialModules
        ? {
            approvedAmount: platformMetrics.expenses.approvedAmount,
            reportCount: platformMetrics.expenses.reportCount,
            totalAmount: platformMetrics.expenses.totalAmount,
            totalRows: platformMetrics.expenses.totalRows,
          }
        : { approvedAmount: 0, reportCount: 0, totalAmount: 0, totalRows: 0 },
      hr: {
        activeEmployees: platformMetrics.workforce.activeEmployees,
        employeesWithoutManagers: platformMetrics.workforce.employeesWithoutManagers,
        totalEmployees: platformMetrics.workforce.totalEmployees,
        totalStructure: platformMetrics.workforce.totalStructure,
        uniqueAreas: platformMetrics.workforce.uniqueAreas,
        uniqueLines: platformMetrics.workforce.uniqueLines,
        vacantPositions: platformMetrics.workforce.openVacancies,
      },
      payroll: showFinancialModules
        ? {
            batchLabel: platformMetrics.payroll.batchLabel,
            employees: platformMetrics.payroll.employees,
            flags: platformMetrics.payroll.flags,
            gross: platformMetrics.payroll.gross,
            net: platformMetrics.payroll.net,
          }
        : { batchLabel: "Self only", employees: 0, flags: 0, gross: 0, net: 0 },
      risk: {
        expiringContracts: platformMetrics.lifecycleRisk.expiringContracts,
        probationEndings: platformMetrics.lifecycleRisk.probationEndings,
      },
      leave: {
        approvedRequests: platformMetrics.leave.approvedRequests,
        managerDecisionActions: platformMetrics.leave.managerDecisionActions,
        paidDays: platformMetrics.leave.paidDays,
        pendingRequests: platformMetrics.leave.pendingRequests,
        rejectedRequests: platformMetrics.leave.rejectedRequests,
        totalRequests: platformMetrics.leave.totalRequests,
        unpaidDays: platformMetrics.leave.unpaidDays,
      },
      sales: {
        achievementRate: showSalesModules ? platformMetrics.sales.achievementRate : null,
        activeProducts: showSalesModules ? platformMetrics.sales.activeProducts : 0,
        salesValue: showSalesModules ? platformMetrics.sales.salesValue : 0,
        targetValue: showSalesModules ? platformMetrics.sales.targetValue : 0,
      },
      executive: {
        pendingResignations: executiveSignals.pendingResignations,
        totalResignations: executiveSignals.totalResignations,
        attritionRate30d:
          platformMetrics.workforce.activeEmployees > 0
            ? (executiveSignals.departuresLast30d / platformMetrics.workforce.activeEmployees) * 100
            : 0,
        criticalProbation: executiveSignals.criticalProbation,
        contractsDueSoon: executiveSignals.contractsDueSoon,
        coachingScore: executiveSignals.coachingScore,
        coachingRedZone: executiveSignals.coachingRedZone,
        overdueLeaveSla: executiveSignals.overdueLeaveSla,
      },
    };

    return {
      access: { showAdminModules, showFinancialModules },
      dataUnavailable,
      generatedAt: new Date().toISOString(),
      health,
      operations,
      overview,
      payrollEligibleCount: showFinancialModules ? eligibleResult.count : 0,
      unresolvedSalaryFlags: showFinancialModules ? executiveSignals.unresolvedSalaryFlags : 0,
    };
  } catch {
    dataUnavailable.push("Platform metrics unavailable.");
  }

  // Run all fetches in parallel — each is isolated so a single failure doesn't cascade
  executiveSignals ??= await executiveSignalsPromise;
  dataUnavailable.push(...executiveSignals.errors);
  const attendanceAgent = await attendanceAgentPromise;
  if (!attendanceAgent) dataUnavailable.push("Attendance agent health unavailable.");

  const [payrollResult, salesResult, employeesResult, dataHealthResult, expensesResult, riskResult, salesHealthResult, eligibleResult, operationsResult] =
    await Promise.allSettled([
      showFinancialModules
        ? canUseCompanyPayrollSummary(accessContext)
          ? fetchPayrollSummary()
          : fetchScopedPayrollSummary(accessContext)
        : Promise.resolve({ batch: null, batchLabel: "Self only", employees: 0, error: null, flags: 0, gross: 0, net: 0 }),
      showSalesModules
        ? fetchSalesSummary(accessContext)
        : Promise.resolve({ achievementRate: null, activeProducts: 0, error: null, salesValue: 0, targetValue: 0 }),
      getEmployeeDirectory(),
      getDataHealthStats(),
      showFinancialModules
        ? fetchExpenseSummary(accessContext)
        : Promise.resolve({ approvedAmount: 0, error: null, reportCount: 0, totalAmount: 0, totalRows: 0 }),
      fetchRiskSummary(accessContext),
      showSalesModules ? fetchSalesHealthCounts(accessContext) : Promise.resolve({ error: null, linkedRows: 0, totalRows: 0 }),
      showFinancialModules
        ? fetchPayrollEligibleCount()
        : Promise.resolve({ count: 0, error: null }),
      getOperationalRecentActivity(accessContext, { limit: 5 }),
    ]);

  // ── Payroll ──────────────────────────────────────────────────────────────
  let payroll: AdminCommandCenterData["overview"]["payroll"] = {
    batchLabel: "—",
    employees: 0,
    gross: 0,
    net: 0,
    flags: 0,
  };
  if (payrollResult.status === "fulfilled") {
    const p = payrollResult.value;
    if (p.error) dataUnavailable.push(p.error);
    payroll = {
      batchLabel: p.batch ? `${p.batch.month}/${p.batch.year}` : "—",
      employees: p.employees,
      gross: p.gross,
      net: p.net,
      flags: p.flags,
    };
  } else {
    dataUnavailable.push("Payroll data unavailable.");
  }

  // ── Sales ────────────────────────────────────────────────────────────────
  let sales: AdminCommandCenterData["overview"]["sales"] = {
    salesValue: 0,
    targetValue: 0,
    achievementRate: null,
    activeProducts: 0,
  };
  if (salesResult.status === "fulfilled") {
    const s = salesResult.value;
    if (s.error) dataUnavailable.push(s.error);
    sales = {
      salesValue: s.salesValue,
      targetValue: s.targetValue,
      achievementRate: s.achievementRate,
      activeProducts: s.activeProducts,
    };
  } else {
    dataUnavailable.push("Sales data unavailable.");
  }

  // ── HR / Employees ───────────────────────────────────────────────────────
  let hr: AdminCommandCenterData["overview"]["hr"] = {
    activeEmployees: 0,
    totalEmployees: 0,
    totalStructure: 0,
    vacantPositions: 0,
    uniqueLines: 0,
    uniqueAreas: 0,
    employeesWithoutManagers: 0,
  };
  const dataHealthStats = dataHealthResult.status === "fulfilled" ? dataHealthResult.value : null;
  if (dataHealthResult.status === "rejected") {
    dataUnavailable.push("Data health structure totals unavailable.");
  } else {
    // Each source the audit could not read leaves its own figure null — name it here so the null
    // reads as "Unavailable", never as a quiet zero.
    for (const source of dataHealthResult.value.unavailable) dataUnavailable.push(`Data health: ${source} unavailable.`);
  }
  if (employeesResult.status === "fulfilled" || dataHealthStats) {
    const e = employeesResult.status === "fulfilled" ? employeesResult.value.summary : null;
    hr = {
      activeEmployees: dataHealthStats?.summary.activeEmployees ?? e?.activeEmployees ?? 0,
      totalEmployees: e?.totalEmployees ?? dataHealthStats?.summary.totalEmployees ?? 0,
      totalStructure: dataHealthStats?.summary.structureNodes ?? e?.totalEmployees ?? 0,
      vacantPositions: dataHealthStats?.summary.vacantPositions ?? 0,
      uniqueLines: e?.uniqueLines ?? 0,
      uniqueAreas: e?.uniqueAreas ?? 0,
      employeesWithoutManagers: e?.employeesWithoutManagers ?? 0,
    };
  }
  if (employeesResult.status === "rejected") {
    dataUnavailable.push("Employee directory unavailable.");
  }

  // ── Expenses ─────────────────────────────────────────────────────────────
  let expenses: AdminCommandCenterData["overview"]["expenses"] = {
    approvedAmount: 0,
    totalAmount: 0,
    totalRows: 0,
    reportCount: 0,
  };
  if (expensesResult.status === "fulfilled") {
    const ex = expensesResult.value;
    if (ex.error) dataUnavailable.push(ex.error);
    else expenses = { approvedAmount: ex.approvedAmount, totalAmount: ex.totalAmount, totalRows: ex.totalRows, reportCount: ex.reportCount };
  } else {
    dataUnavailable.push("Expense data unavailable.");
  }

  // ── Risk ─────────────────────────────────────────────────────────────────
  let risk: AdminCommandCenterData["overview"]["risk"] = {
    expiringContracts: 0,
    probationEndings: 0,
  };
  const leave: AdminCommandCenterData["overview"]["leave"] = {
    approvedRequests: 0,
    managerDecisionActions: 0,
    paidDays: 0,
    pendingRequests: 0,
    rejectedRequests: 0,
    totalRequests: 0,
    unpaidDays: 0,
  };
  // The UNMEASURED shape. Counts stay 0; both rates are `null`, because "0 of 0 mappings" is not
  // 100% ready — it is a section nobody read, and a 1 here is the same fabricated all-clear that
  // `emptyPlatformMetrics()` used to hand out.
  const attendance: AdminCommandCenterData["overview"]["attendance"] = {
    activeMappings: 0,
    activePolicies: 0,
    currentMonthWorkingDays: 0,
    mappingReadinessRate: null,
    missingDeviceMappings: 0,
    policyCoverageRate: null,
    totalDeviceMappings: 0,
    totalPolicies: 0,
  };
  if (riskResult.status === "fulfilled") {
    const rv = riskResult.value;
    if (rv.error) dataUnavailable.push(rv.error);
    else risk = { expiringContracts: rv.expiringContracts, probationEndings: rv.probationEndings };
  } else {
    dataUnavailable.push("Risk data unavailable.");
  }

  // ── Health ───────────────────────────────────────────────────────────────
  const salesHealth = salesHealthResult.status === "fulfilled"
    ? salesHealthResult.value
    : { error: "Sales linkage data unavailable.", linkedRows: 0, totalRows: 0 };
  if (salesHealth.error) dataUnavailable.push(salesHealth.error);
  const health = dataHealthStats
    ? buildDataHealthFromStats(dataHealthStats, salesHealth)
    : buildDataHealth(
      employeesResult.status === "fulfilled" ? employeesResult.value : null,
      salesHealth,
    );

  // ── Payroll eligible count ────────────────────────────────────────────────
  const payrollEligibleCount =
    showFinancialModules && eligibleResult.status === "fulfilled" ? eligibleResult.value.count : 0;
  if (eligibleResult.status === "fulfilled" && eligibleResult.value.error) {
    dataUnavailable.push(eligibleResult.value.error);
  } else if (eligibleResult.status === "rejected") {
    dataUnavailable.push("Payroll eligible count unavailable.");
  }
  const operations =
    operationsResult.status === "fulfilled" ? operationsResult.value : emptyOperations;
  if (operationsResult.status === "rejected") {
    dataUnavailable.push("Operational activity unavailable.");
  }

  return {
    access: { showAdminModules, showFinancialModules },
    dataUnavailable,
    generatedAt: new Date().toISOString(),
    health,
    operations,
    overview: {
      hr,
      payroll,
      sales,
      expenses,
      risk,
      leave,
      attendance,
      attendanceAgent,
      executive: {
        pendingResignations: executiveSignals.pendingResignations,
        totalResignations: executiveSignals.totalResignations,
        attritionRate30d:
          hr.activeEmployees > 0 ? (executiveSignals.departuresLast30d / hr.activeEmployees) * 100 : 0,
        criticalProbation: executiveSignals.criticalProbation,
        contractsDueSoon: executiveSignals.contractsDueSoon,
        coachingScore: executiveSignals.coachingScore,
        coachingRedZone: executiveSignals.coachingRedZone,
        overdueLeaveSla: executiveSignals.overdueLeaveSla,
      },
    },
    payrollEligibleCount,
    unresolvedSalaryFlags: showFinancialModules ? executiveSignals.unresolvedSalaryFlags : 0,
  };
}

