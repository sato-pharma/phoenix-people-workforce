import { isDesignatedHrSpecialist, type AccessContext } from "@/lib/auth/permissions";
import { getDataHealthStats, getSalaryFlags, type DataHealthStats } from "@/lib/admin/service";
import { buildCoachingReportAnalytics } from "@/lib/coaching/analytics";
import { getCoachingReports } from "@/lib/coaching/service";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { getDeductionInboxKpis } from "@/lib/deductions-governance/service";
import { getResignationsDashboardData } from "@/lib/resignations/service";
import { getVacationReportData } from "@/lib/vacation/service";
import { getEmployeeDirectory, type EmployeeDirectoryData } from "@/lib/employees/employee-directory";
import { isMissingRequiredManager } from "@/lib/employees/hierarchy-governance";
import { buildLifecycleRiskMetrics } from "@/lib/lifecycle-risk/metrics";
import { getOperationalRecentActivity, type OperationalActivitySummary } from "@/lib/operations/events";
import { getPayrollExpenseMetrics } from "@/lib/payroll/expenses";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { getPlatformMetrics } from "@/lib/platform/metrics";
import { getProbationRows } from "@/lib/probation/service";
import { buildRecruitmentOnboardingMetrics } from "@/lib/recruitment/onboarding-metrics";
import { getSalesPlatformMetrics } from "@/lib/sales/service";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { calculateWorkforceStructureSummary } from "@/lib/workforce/seat-lifecycle";

/**
 * Resolves an employee's direct manager display name live from the employees
 * table by HR_ID (their own manager_hr_id -> the manager's full_name). Used for
 * the admin command-center welcome hero so every signed-in user sees their
 * direct manager (only someone with no manager — the CEO — resolves to null).
 */
export async function loadDirectManagerName(employeeHrId: string | null | undefined): Promise<string | null> {
  const target = String(employeeHrId ?? "").trim();
  if (!target) return null;
  const supabase = getSupabaseAdmin();
  const { data: self } = await supabase
    .from("employees")
    .select("manager_hr_id")
    .eq("hr_id", target)
    .maybeSingle();
  const managerHrId = String((self as { manager_hr_id?: string | null } | null)?.manager_hr_id ?? "").trim();
  if (!managerHrId) return null;
  const { data: manager } = await supabase
    .from("employees")
    .select("full_name")
    .eq("hr_id", managerHrId)
    .maybeSingle();
  const fullName = (manager as { full_name?: string | null } | null)?.full_name;
  return fullName ? String(fullName) : null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DataHealthMetrics = {
  attendanceMappingIssues: number;
  attendanceReadinessRate: number;
  leaveApprovedRequests: number;
  leavePendingRequests: number;
  leaveRejectedRequests: number;
  employeeHealthRate: number;
  healthyEmployees: number;
  totalEmployees: number;
  totalStructure: number;
  vacantPositions: number;
  missingManager: number;
  missingJobTitle: number;
  salesLinkageRate: number;
  salesLinkageBatch: string | null;
};

/** Flat snapshot that AdminCommandCenter renders — avoids OverviewDashboardData entirely. */
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
      achievementRate: number;
      activeProducts: number;
    };
    expenses: {
      approvedAmount: number;
      totalAmount: number;
      totalRows: number;
      reportCount: number;
    };
    recruitment: {
      totalOffers: number;
      pendingOffers: number;
      acceptedOffers: number;
      rejectedOffers: number;
      acceptanceRate: number;
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
      mappingReadinessRate: number;
      missingDeviceMappings: number;
      policyCoverageRate: number;
      totalDeviceMappings: number;
      totalPolicies: number;
    };
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
    // Deductions governance summary (P2).
    deductions: {
      pending: number;
      disputed: number;
      needsFollowUp: number;
      employeesAffected: number;
      estimatedAmount: number;
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

async function fetchSalesHealthCounts(): Promise<{
  error: string | null;
  linkedRows: number;
  totalRows: number;
}> {
  const supabase = getSupabaseAdmin();
  try {
    const [totalResult, linkedResult] = await Promise.all([
      supabase.from("sales_records").select("*", { count: "exact", head: true }).lt("year", 2090),
      supabase.from("sales_records").select("*", { count: "exact", head: true }).lt("year", 2090).eq("link_status", "linked"),
    ]);
    if (totalResult.error) throw totalResult.error;
    if (linkedResult.error) throw linkedResult.error;
    return {
      error: null,
      linkedRows: linkedResult.count ?? 0,
      totalRows: totalResult.count ?? 0,
    };
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
    openVacancies: directory?.lookups.workforceVacancies.length ?? 0,
  });

  return {
    attendanceMappingIssues: 0,
    attendanceReadinessRate: 1,
    leaveApprovedRequests: 0,
    leavePendingRequests: 0,
    leaveRejectedRequests: 0,
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

// Lightweight health summary for the Command Center, derived from the cheap
// count-based platform metrics + sales linkage counts it already fetches — so the
// page never pays for the full governance audit (which scans the entire
// sales_records table). The exact audit lives on /admin/data-health.
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
  const empty = { achievementRate: 0, activeProducts: 0, error: null, salesValue: 0, targetValue: 0 };

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

async function fetchRecruitmentSummary(): Promise<{
  totalOffers: number;
  pendingOffers: number;
  acceptedOffers: number;
  rejectedOffers: number;
  acceptanceRate: number;
  error: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const empty = {
    totalOffers: 0,
    pendingOffers: 0,
    acceptedOffers: 0,
    rejectedOffers: 0,
    acceptanceRate: 0,
    error: null,
  };

  try {
    const { data: rows, error } = await supabase
      .from("job_offers")
      .select("id,offer_code,candidate_name,candidate_email,candidate_phone,job_title,template_key,area_scope,area_id,department_id,line_id,manager_hr_id,position_id,salary_amount,start_date,expires_at,status,accepted_at,rejected_at,employee_hr_id,onboarding_status,created_at,updated_at")
      .limit(5000);
    if (error) throw error;

    const offers = (rows ?? []).map((row) => ({
      acceptedAt: row.accepted_at,
      areaId: row.area_id,
      areaScope: row.area_scope,
      candidateEmail: row.candidate_email,
      candidateName: row.candidate_name,
      candidatePhone: row.candidate_phone,
      createdAt: row.created_at,
      departmentId: row.department_id,
      departmentName: null,
      employeeHrId: row.employee_hr_id,
      expiresAt: row.expires_at,
      id: row.id,
      jobTitle: row.job_title,
      lineId: row.line_id,
      lineName: null,
      managerHrId: row.manager_hr_id,
      managerName: null,
      offerCode: row.offer_code,
      onboardingStatus: row.onboarding_status,
      positionId: row.position_id,
      rejectedAt: row.rejected_at,
      salaryAmount: row.salary_amount,
      startDate: row.start_date,
      status: row.status,
      templateKey: row.template_key,
      updatedAt: row.updated_at,
    }));
    const recruitment = buildRecruitmentOnboardingMetrics({ offerRows: offers });

    return {
      totalOffers: recruitment.totalOffers,
      pendingOffers: recruitment.pendingOffers,
      acceptedOffers: recruitment.acceptedOffers,
      rejectedOffers: recruitment.rejectedOffers,
      acceptanceRate: recruitment.acceptanceRate,
      error: null,
    };
  } catch {
    return { ...empty, error: "Recruitment data unavailable." };
  }
}

async function fetchRiskSummary(accessContext: AccessContext): Promise<{
  expiringContracts: number;
  probationEndings: number;
  error: string | null;
}> {
  const empty = { expiringContracts: 0, probationEndings: 0, error: null };

  try {
    const [contractResult, probations] = await Promise.all([
      getContractRenewalDashboardData(accessContext),
      getProbationRows(accessContext),
    ]);
    const lifecycleRisk = buildLifecycleRiskMetrics({
      contracts: contractResult.rows.map((row) => ({
        contractRenewalDate: row.contract_renewal_date,
        employeeHrId: row.hr_id,
        employeeName: row.full_name,
        workflowStatus: row.workflow?.status ?? null,
      })),
      probations: probations.map((row) => ({
        daysRemaining: row.days_remaining,
        employeeHrId: row.hr_id,
        employeeName: row.full_name,
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
  deductions: {
    pending: number;
    disputed: number;
    needsFollowUp: number;
    employeesAffected: number;
    estimatedAmount: number;
  };
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
    deductionsResult,
  ] = await Promise.allSettled([
    getResignationsDashboardData(),
    getProbationRows(accessContext),
    getContractRenewalDashboardData(accessContext),
    options.showFinancial ? getSalaryFlags() : Promise.resolve(null),
    getCoachingReports({}, accessContext),
    getVacationReportData(accessContext, {}),
    getDeductionInboxKpis({ access: accessContext }),
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
      coachingRedZone = (analytics.zoneCounts.critical_red ?? 0) + (analytics.zoneCounts.red_zone ?? 0);
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

  // Deductions governance summary.
  let deductions = { pending: 0, disputed: 0, needsFollowUp: 0, employeesAffected: 0, estimatedAmount: 0 };
  if (deductionsResult.status === "fulfilled") {
    const kpis = deductionsResult.value;
    deductions = {
      pending: kpis.pending,
      disputed: kpis.disputed,
      needsFollowUp: kpis.needsFollowUp,
      employeesAffected: kpis.employeesAffected,
      estimatedAmount: options.showFinancial ? kpis.estimatedAmountSubtotal : 0,
    };
  } else {
    errors.push("Deductions data unavailable.");
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
    deductions,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function getAdminCommandCenterData(accessContext: AccessContext): Promise<AdminCommandCenterData> {
  const dataUnavailable: string[] = [];
  const showFinancialModules = !isDesignatedHrSpecialist(accessContext);
  const showAdminModules = showFinancialModules;
  const showSalesModules = !isDesignatedHrSpecialist(accessContext);
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
      deductions: { pending: 0, disputed: 0, needsFollowUp: 0, employeesAffected: 0, estimatedAmount: 0 },
      errors: ["Executive signals unavailable."],
    }));
  let executiveSignals: ExecutiveSignals | null = null;

  try {
    const [executiveSignalsResult, platformMetrics, salesHealth, eligibleResult, operations] = await Promise.all([
      executiveSignalsPromise,
      getPlatformMetrics(accessContext),
      showSalesModules ? fetchSalesHealthCounts() : Promise.resolve({ error: null, linkedRows: 0, totalRows: 0 }),
      showFinancialModules ? fetchPayrollEligibleCount() : Promise.resolve({ count: 0, error: null }),
      getOperationalRecentActivity(accessContext, { limit: 5 }),
    ]);
    executiveSignals = executiveSignalsResult;
    dataUnavailable.push(...executiveSignals.errors);
    dataUnavailable.push(...platformMetrics.dataUnavailable);
    if (salesHealth.error) dataUnavailable.push(salesHealth.error);
    if (eligibleResult.error) dataUnavailable.push(eligibleResult.error);

    // Derived from the cheap count-based metrics already loaded above — NOT the full
    // governance audit (which scans the entire sales_records table and was the cause
    // of the ~10s Command Center load). The exact audit lives on /admin/data-health.
    const health = buildDataHealthFromMetrics(platformMetrics, salesHealth);

    const overview = {
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
      recruitment: {
        acceptanceRate: platformMetrics.recruitment.acceptanceRate,
        acceptedOffers: platformMetrics.recruitment.acceptedOffers,
        pendingOffers: platformMetrics.recruitment.pendingOffers,
        rejectedOffers: platformMetrics.recruitment.rejectedOffers,
        totalOffers: platformMetrics.recruitment.totalOffers,
      },
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
        achievementRate: showSalesModules ? platformMetrics.sales.achievementRate : 0,
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
      deductions: executiveSignals.deductions,
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

  const [payrollResult, salesResult, employeesResult, dataHealthResult, expensesResult, recruitmentResult, riskResult, salesHealthResult, eligibleResult, operationsResult] =
    await Promise.allSettled([
      showFinancialModules
        ? canUseCompanyPayrollSummary(accessContext)
          ? fetchPayrollSummary()
          : fetchScopedPayrollSummary(accessContext)
        : Promise.resolve({ batch: null, batchLabel: "Self only", employees: 0, error: null, flags: 0, gross: 0, net: 0 }),
      showSalesModules
        ? fetchSalesSummary(accessContext)
        : Promise.resolve({ achievementRate: 0, activeProducts: 0, error: null, salesValue: 0, targetValue: 0 }),
      getEmployeeDirectory(),
      getDataHealthStats(),
      showFinancialModules
        ? fetchExpenseSummary(accessContext)
        : Promise.resolve({ approvedAmount: 0, error: null, reportCount: 0, totalAmount: 0, totalRows: 0 }),
      fetchRecruitmentSummary(),
      fetchRiskSummary(accessContext),
      showSalesModules ? fetchSalesHealthCounts() : Promise.resolve({ error: null, linkedRows: 0, totalRows: 0 }),
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
    achievementRate: 0,
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

  // ── Recruitment ──────────────────────────────────────────────────────────
  let recruitment: AdminCommandCenterData["overview"]["recruitment"] = {
    totalOffers: 0,
    pendingOffers: 0,
    acceptedOffers: 0,
    rejectedOffers: 0,
    acceptanceRate: 0,
  };
  if (recruitmentResult.status === "fulfilled") {
    const r = recruitmentResult.value;
    if (r.error) dataUnavailable.push(r.error);
    else recruitment = { totalOffers: r.totalOffers, pendingOffers: r.pendingOffers, acceptedOffers: r.acceptedOffers, rejectedOffers: r.rejectedOffers, acceptanceRate: r.acceptanceRate };
  } else {
    dataUnavailable.push("Recruitment data unavailable.");
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
  const attendance: AdminCommandCenterData["overview"]["attendance"] = {
    activeMappings: 0,
    activePolicies: 0,
    currentMonthWorkingDays: 0,
    mappingReadinessRate: 1,
    missingDeviceMappings: 0,
    policyCoverageRate: 1,
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
      recruitment,
      risk,
      leave,
      attendance,
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
      deductions: executiveSignals.deductions,
    },
    payrollEligibleCount,
    unresolvedSalaryFlags: showFinancialModules ? executiveSignals.unresolvedSalaryFlags : 0,
  };
}

