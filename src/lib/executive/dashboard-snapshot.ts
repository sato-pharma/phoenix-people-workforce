import type { AdminCommandCenterData } from "@/lib/admin/command-center";
import type { AccessContext } from "@/lib/auth/permissions";
import type { CeoBriefData, BriefSignal, SignalFormat } from "@/lib/ceo/brief";
import { computeCompanyHealth, type CompanyHealth } from "@/lib/ceo/health-score";
import { buildStrategicRiskRegister, type RiskRegister } from "@/lib/ceo/risk";
import type { OperationalActivitySummary } from "@/lib/operations/events";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export type ExecutiveDashboardSourceKey =
  | "workforce"
  | "vacancies"
  | "payroll"
  | "sales"
  | "expenses"
  | "contracts"
  | "probation"
  | "recruitment"
  | "leave"
  | "attendance"
  | "operations";

export type ExecutiveDashboardSourceStatus = "available" | "unavailable" | "restricted";

export type ExecutiveDashboardSource = {
  sourceName: string;
  status: ExecutiveDashboardSourceStatus;
  asOf: string | null;
  authorizationScope: string;
  unavailableReason: string | null;
  durationMs: number | null;
};

export type ExecutiveDashboardMetrics = {
  workforce: AdminCommandCenterData["overview"]["hr"] & {
    employeeHealthRate: number;
  };
  payroll: AdminCommandCenterData["overview"]["payroll"];
  sales: AdminCommandCenterData["overview"]["sales"] & {
    dataQualityRate: number;
  };
  expenses: AdminCommandCenterData["overview"]["expenses"];
  recruitment: AdminCommandCenterData["overview"]["recruitment"];
  risk: AdminCommandCenterData["overview"]["risk"];
  leave: AdminCommandCenterData["overview"]["leave"];
  attendance: AdminCommandCenterData["overview"]["attendance"];
  executive: AdminCommandCenterData["overview"]["executive"];
  deductions: AdminCommandCenterData["overview"]["deductions"];
  operations: OperationalActivitySummary;
  payrollEligibleCount: number;
  unresolvedSalaryFlags: number;
  health: AdminCommandCenterData["health"];
};

export type ExecutiveDashboardSnapshot = {
  generatedAt: string;
  viewerScope: {
    hrId: string | null;
    loginId: string | null;
    role: string;
    scope: string;
    source: AccessContext["source"];
  };
  sources: Record<ExecutiveDashboardSourceKey, ExecutiveDashboardSource>;
  metrics: ExecutiveDashboardMetrics;
  dataUnavailable: string[];
  data: AdminCommandCenterData;
  brief: CeoBriefData;
  health: CompanyHealth;
  risk: RiskRegister;
};

type RpcSourceDefinition = {
  key: ExecutiveDashboardSourceKey;
  sourceName: string;
  rpc: string;
};

const NORMAL_TARGET_MS = 2000;
export const EXECUTIVE_SNAPSHOT_HARD_TIMEOUT_MS = 9000;

const SOURCE_DEFINITIONS: RpcSourceDefinition[] = [
  { key: "workforce", sourceName: "Employees", rpc: "phx_exec_workforce_snapshot" },
  { key: "vacancies", sourceName: "Vacancies", rpc: "phx_exec_vacancies_snapshot" },
  { key: "payroll", sourceName: "Payroll", rpc: "phx_exec_payroll_snapshot" },
  { key: "sales", sourceName: "Sales", rpc: "phx_exec_sales_snapshot" },
  { key: "expenses", sourceName: "Expenses", rpc: "phx_exec_expenses_snapshot" },
  { key: "contracts", sourceName: "Contracts", rpc: "phx_exec_contracts_snapshot" },
  { key: "probation", sourceName: "Probation", rpc: "phx_exec_probation_snapshot" },
  { key: "recruitment", sourceName: "Recruitment", rpc: "phx_exec_recruitment_snapshot" },
  { key: "leave", sourceName: "Leave", rpc: "phx_exec_leave_snapshot" },
  { key: "attendance", sourceName: "Attendance", rpc: "phx_exec_attendance_snapshot" },
  { key: "operations", sourceName: "Operational Health", rpc: "phx_exec_operations_snapshot" },
];

const SOURCE_TIMEOUT_MS = Math.min(EXECUTIVE_SNAPSHOT_HARD_TIMEOUT_MS, 8000);

function safeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function emptyOperations(): OperationalActivitySummary {
  return {
    failureCount24h: 0,
    lastEventAt: null,
    recent: [],
    staleSources: [],
    totalEvents24h: 0,
  };
}

function emptySource(definition: RpcSourceDefinition, access: AccessContext): ExecutiveDashboardSource {
  return {
    asOf: null,
    authorizationScope: `${access.role}:${access.scope}`,
    durationMs: null,
    sourceName: definition.sourceName,
    status: "unavailable",
    unavailableReason: `${definition.sourceName} source unavailable.`,
  };
}

function sourceParams(access: AccessContext) {
  return {
    p_viewer_hr_id: access.hrId,
    p_viewer_login_id: access.loginId ?? null,
    p_viewer_role: access.role,
    p_viewer_scope: access.scope,
    p_viewer_source: access.source,
  };
}

async function withTimeout<T>(label: string, loader: () => PromiseLike<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      loader(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${SOURCE_TIMEOUT_MS}ms.`)), SOURCE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function loadRpcSource(
  definition: RpcSourceDefinition,
  access: AccessContext,
): Promise<{ definition: RpcSourceDefinition; payload: Record<string, unknown> | null; source: ExecutiveDashboardSource }> {
  const started = Date.now();
  try {
    const { data, error } = await withTimeout<{
      data: unknown;
      error: { message?: string } | null;
    }>(definition.sourceName, () =>
      getSupabaseAdmin().rpc(definition.rpc, sourceParams(access)) as PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
      }>,
    );
    const durationMs = Date.now() - started;
    if (error) {
      throw new Error(error.message ?? `${definition.sourceName} RPC failed.`);
    }
    const payload = asRecord(data);
    const sourcePayload = asRecord(payload.source);
    return {
      definition,
      payload,
      source: {
        asOf: safeString(sourcePayload.asOf, safeString(sourcePayload.as_of, new Date().toISOString())),
        authorizationScope: safeString(sourcePayload.authorizationScope, `${access.role}:${access.scope}`),
        durationMs,
        sourceName: safeString(sourcePayload.sourceName, definition.sourceName),
        status: safeString(sourcePayload.status, "available") as ExecutiveDashboardSourceStatus,
        unavailableReason: typeof sourcePayload.unavailableReason === "string" ? sourcePayload.unavailableReason : null,
      },
    };
  } catch (error) {
    const durationMs = Date.now() - started;
    return {
      definition,
      payload: null,
      source: {
        ...emptySource(definition, access),
        durationMs,
        unavailableReason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function metricPayload(
  loaded: Map<ExecutiveDashboardSourceKey, Record<string, unknown>>,
  key: ExecutiveDashboardSourceKey,
) {
  return asRecord(loaded.get(key)?.metrics);
}

function buildSignal(
  key: string,
  label: string,
  latest: number | null,
  positiveIsUp: boolean,
  format: SignalFormat,
): BriefSignal {
  return {
    comparisonLabel: "snapshot baseline unavailable",
    deltaPct: null,
    direction: "unavailable",
    format,
    key,
    label,
    latest,
    positiveIsUp,
    previous: null,
  };
}

function buildBriefFromSnapshot(metrics: ExecutiveDashboardMetrics): CeoBriefData {
  const alerts = [
    ...Array.from({ length: Math.max(0, metrics.risk.expiringContracts) }, (_, index) => ({
      date: "",
      days: 0,
      name: `Contract risk ${index + 1}`,
      type: "contract" as const,
    })),
    ...Array.from({ length: Math.max(0, metrics.risk.probationEndings) }, (_, index) => ({
      date: "",
      days: 0,
      name: `Probation risk ${index + 1}`,
      type: "probation" as const,
    })),
  ].slice(0, 12);

  return {
    activity: metrics.operations.recent.map((row) => ({
      description: row.description,
      module: row.module,
      status: row.status,
      timestamp: row.timestamp,
      userName: row.userName,
    })),
    alerts,
    impact: {
      grossMargin: metrics.sales.salesValue > 0
        ? ((metrics.sales.salesValue - metrics.payroll.gross) / metrics.sales.salesValue) * 100
        : 0,
      peopleCost: metrics.payroll.gross,
      revenue: metrics.sales.salesValue,
    },
    salesAchievementPct: metrics.sales.achievementRate * 100,
    signals: [
      buildSignal("sales_achievement", "Sales achievement", metrics.sales.achievementRate * 100, true, "percent"),
      buildSignal("revenue", "Revenue", metrics.sales.salesValue, true, "currency"),
      buildSignal(
        "gross_margin",
        "Gross margin",
        metrics.sales.salesValue > 0 ? ((metrics.sales.salesValue - metrics.payroll.gross) / metrics.sales.salesValue) * 100 : null,
        true,
        "percent",
      ),
      buildSignal("people_cost", "People cost", metrics.payroll.gross, false, "currency"),
      buildSignal("expenses", "Outstation expenses", metrics.expenses.approvedAmount, false, "currency"),
    ],
    upcoming: alerts.slice(0, 6),
    weeklySnapshotAvailable: false,
    workforce: {
      activeEmployees: metrics.workforce.activeEmployees,
      totalStructure: metrics.workforce.totalStructure,
      vacantPositions: metrics.workforce.vacantPositions,
    },
  };
}

function buildMetricsFromSources(loaded: Map<ExecutiveDashboardSourceKey, Record<string, unknown>>): ExecutiveDashboardMetrics {
  const workforce = metricPayload(loaded, "workforce");
  const vacancies = metricPayload(loaded, "vacancies");
  const payroll = metricPayload(loaded, "payroll");
  const sales = metricPayload(loaded, "sales");
  const expenses = metricPayload(loaded, "expenses");
  const contracts = metricPayload(loaded, "contracts");
  const probation = metricPayload(loaded, "probation");
  const recruitment = metricPayload(loaded, "recruitment");
  const leave = metricPayload(loaded, "leave");
  const attendance = metricPayload(loaded, "attendance");
  const operations = metricPayload(loaded, "operations");

  const activeEmployees = safeNumber(workforce.activeEmployees);
  const totalEmployees = safeNumber(workforce.totalEmployees);
  const openVacancies = safeNumber(vacancies.openVacancies, safeNumber(workforce.openVacancies));
  const healthyEmployees = safeNumber(workforce.healthyEmployees, activeEmployees);
  const totalStructure = safeNumber(workforce.totalStructure, activeEmployees + openVacancies);
  const payrollFlags = safeNumber(payroll.flags);
  const payrollEmployees = safeNumber(payroll.employees);
  const salesLinkageRate = safeNumber(sales.dataQualityRate, 1) * 100;

  return {
    attendance: {
      activeMappings: safeNumber(attendance.activeMappings),
      activePolicies: safeNumber(attendance.activePolicies),
      currentMonthWorkingDays: safeNumber(attendance.currentMonthWorkingDays),
      mappingReadinessRate: safeNumber(attendance.mappingReadinessRate, 1),
      missingDeviceMappings: safeNumber(attendance.missingDeviceMappings),
      policyCoverageRate: safeNumber(attendance.policyCoverageRate, 1),
      totalDeviceMappings: safeNumber(attendance.totalDeviceMappings),
      totalPolicies: safeNumber(attendance.totalPolicies),
    },
    deductions: {
      disputed: 0,
      employeesAffected: 0,
      estimatedAmount: 0,
      needsFollowUp: 0,
      pending: 0,
    },
    executive: {
      attritionRate30d: 0,
      coachingRedZone: 0,
      coachingScore: 0,
      contractsDueSoon: safeNumber(contracts.contractsDueSoon),
      criticalProbation: safeNumber(probation.criticalProbation),
      overdueLeaveSla: safeNumber(leave.overdueSla),
      pendingResignations: 0,
      totalResignations: 0,
    },
    expenses: {
      approvedAmount: safeNumber(expenses.approvedAmount),
      reportCount: safeNumber(expenses.reportCount),
      totalAmount: safeNumber(expenses.totalAmount),
      totalRows: safeNumber(expenses.totalRows),
    },
    health: {
      attendanceMappingIssues: safeNumber(attendance.missingDeviceMappings),
      attendanceReadinessRate: safeNumber(attendance.mappingReadinessRate, 1),
      employeeHealthRate: totalEmployees > 0 ? (healthyEmployees / totalEmployees) * 100 : 100,
      healthyEmployees,
      leaveApprovedRequests: safeNumber(leave.approvedRequests),
      leavePendingRequests: safeNumber(leave.pendingRequests),
      leaveRejectedRequests: safeNumber(leave.rejectedRequests),
      missingJobTitle: safeNumber(workforce.missingJobTitle),
      missingManager: safeNumber(workforce.employeesWithoutManagers),
      salesLinkageBatch: null,
      salesLinkageRate,
      totalEmployees,
      totalStructure,
      vacantPositions: openVacancies,
    },
    leave: {
      approvedRequests: safeNumber(leave.approvedRequests),
      managerDecisionActions: safeNumber(leave.managerDecisionActions),
      paidDays: safeNumber(leave.paidDays),
      pendingRequests: safeNumber(leave.pendingRequests),
      rejectedRequests: safeNumber(leave.rejectedRequests),
      totalRequests: safeNumber(leave.totalRequests),
      unpaidDays: safeNumber(leave.unpaidDays),
    },
    operations: {
      ...emptyOperations(),
      failureCount24h: safeNumber(operations.failureCount24h),
      lastEventAt: typeof operations.lastEventAt === "string" ? operations.lastEventAt : null,
      staleSources: Array.isArray(operations.staleSources) ? operations.staleSources.map(String) : [],
      totalEvents24h: safeNumber(operations.totalEvents24h),
    },
    payroll: {
      batchLabel: safeString(payroll.batchLabel, "No batch"),
      employees: payrollEmployees,
      flags: payrollFlags,
      gross: safeNumber(payroll.gross),
      net: safeNumber(payroll.net),
    },
    payrollEligibleCount: safeNumber(payroll.payrollEligibleCount),
    recruitment: {
      acceptanceRate: safeNumber(recruitment.acceptanceRate),
      acceptedOffers: safeNumber(recruitment.acceptedOffers),
      pendingOffers: safeNumber(recruitment.pendingOffers),
      rejectedOffers: safeNumber(recruitment.rejectedOffers),
      totalOffers: safeNumber(recruitment.totalOffers),
    },
    risk: {
      expiringContracts: safeNumber(contracts.expiringContracts),
      probationEndings: safeNumber(probation.probationEndings),
    },
    sales: {
      achievementRate: safeNumber(sales.achievementRate),
      activeProducts: safeNumber(sales.activeProducts),
      dataQualityRate: safeNumber(sales.dataQualityRate, 1),
      salesValue: safeNumber(sales.salesValue),
      targetValue: safeNumber(sales.targetValue),
    },
    unresolvedSalaryFlags: payrollFlags,
    workforce: {
      activeEmployees,
      employeeHealthRate: totalEmployees > 0 ? activeEmployees / totalEmployees : 1,
      employeesWithoutManagers: safeNumber(workforce.employeesWithoutManagers),
      totalEmployees,
      totalStructure,
      uniqueAreas: safeNumber(workforce.uniqueAreas),
      uniqueLines: safeNumber(workforce.uniqueLines),
      vacantPositions: openVacancies,
    },
  };
}

function buildAdminData(
  access: AccessContext,
  generatedAt: string,
  metrics: ExecutiveDashboardMetrics,
  dataUnavailable: string[],
): AdminCommandCenterData {
  return {
    access: {
      showAdminModules: true,
      showFinancialModules: true,
    },
    dataUnavailable,
    generatedAt,
    health: metrics.health,
    operations: metrics.operations,
    overview: {
      attendance: metrics.attendance,
      deductions: metrics.deductions,
      executive: metrics.executive,
      expenses: metrics.expenses,
      hr: metrics.workforce,
      leave: metrics.leave,
      payroll: metrics.payroll,
      recruitment: metrics.recruitment,
      risk: metrics.risk,
      sales: metrics.sales,
    },
    payrollEligibleCount: metrics.payrollEligibleCount,
    unresolvedSalaryFlags: metrics.unresolvedSalaryFlags,
  };
}

export function buildExecutiveDashboardSnapshotFromSources(input: {
  access: AccessContext;
  generatedAt?: string;
  loadedSources: Array<{ definition: RpcSourceDefinition; payload: Record<string, unknown> | null; source: ExecutiveDashboardSource }>;
}): ExecutiveDashboardSnapshot {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const loaded = new Map<ExecutiveDashboardSourceKey, Record<string, unknown>>();
  const sources = Object.fromEntries(
    SOURCE_DEFINITIONS.map((definition) => [definition.key, emptySource(definition, input.access)]),
  ) as Record<ExecutiveDashboardSourceKey, ExecutiveDashboardSource>;

  for (const item of input.loadedSources) {
    sources[item.definition.key] = item.source;
    if (item.payload) loaded.set(item.definition.key, item.payload);
  }

  const dataUnavailable = SOURCE_DEFINITIONS
    .filter((definition) => sources[definition.key].status !== "available")
    .map((definition) => sources[definition.key].unavailableReason ?? `${definition.sourceName} source unavailable.`);
  const metrics = buildMetricsFromSources(loaded);
  const data = buildAdminData(input.access, generatedAt, metrics, dataUnavailable);
  const brief = buildBriefFromSnapshot(metrics);
  const risk = buildStrategicRiskRegister({
    alerts: brief.alerts,
    alertsAvailable: sources.contracts.status === "available" || sources.probation.status === "available",
    dataUnavailable,
    failureCount24h: metrics.operations.failureCount24h,
    payrollFlags: metrics.payroll.flags,
    pendingLeave: metrics.leave.pendingRequests,
    pendingOffers: metrics.recruitment.pendingOffers,
    staleSources: metrics.operations.staleSources,
  });
  const criticalRiskCount = risk.rows.filter((row) => row.severity === "critical").length;
  const health = computeCompanyHealth({
    criticalRiskCount,
    dataUnavailableCount: dataUnavailable.length,
    employeeHealthRate: metrics.health.employeeHealthRate,
    payrollEmployees: metrics.payroll.employees,
    payrollFlags: metrics.payroll.flags,
    salesAchievementPct: metrics.sales.achievementRate * 100,
    salesLinkageRate: metrics.health.salesLinkageRate,
  });

  return {
    brief,
    data,
    dataUnavailable,
    generatedAt,
    health,
    metrics,
    risk,
    sources,
    viewerScope: {
      hrId: input.access.hrId,
      loginId: input.access.loginId ?? null,
      role: input.access.role,
      scope: input.access.scope,
      source: input.access.source,
    },
  };
}

export async function getExecutiveDashboardSnapshot(access: AccessContext): Promise<ExecutiveDashboardSnapshot> {
  const started = Date.now();
  const loadedSources = await Promise.all(SOURCE_DEFINITIONS.map((definition) => loadRpcSource(definition, access)));
  const snapshot = buildExecutiveDashboardSnapshotFromSources({ access, loadedSources });
  if (Date.now() - started > NORMAL_TARGET_MS) {
    console.warn("Executive dashboard snapshot exceeded normal performance target.", {
      durationMs: Date.now() - started,
      targetMs: NORMAL_TARGET_MS,
    });
  }
  return snapshot;
}
