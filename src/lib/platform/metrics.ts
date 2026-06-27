import {
  canAccess,
  filterEmployeeDirectoryForAccess,
  type AccessContext,
} from "@/lib/auth/permissions";
import { getAttendanceDeviceUserMappingDashboard } from "@/lib/attendance/device-user-mapping";
import { buildAttendanceReadinessMetrics } from "@/lib/attendance/metrics";
import { getAttendancePolicyDashboard } from "@/lib/attendance/policies";
import { buildCommunicationMetrics } from "@/lib/communication/metrics";
import { getContractRenewalDashboardData } from "@/lib/contracts/service";
import { getEmailTemplateCatalog } from "@/lib/email-templates/service";
import { getEmployeeDirectory, type EmployeeDirectoryData } from "@/lib/employees/employee-directory";
import { isDisposableFixtureText } from "@/lib/fixture-hygiene";
import { countHrWorkingDays } from "@/lib/hr-calendar/calendar-logic";
import { getHiringDocumentsDashboard } from "@/lib/hiring-documents/service";
import { buildLifecycleRiskMetrics, type LifecycleRiskAlert } from "@/lib/lifecycle-risk/metrics";
import { getEmailNotificationOutboxStats } from "@/lib/notifications/email";
import { getOfferDashboard } from "@/lib/offers/service";
import { getPayrollExpenseMetrics } from "@/lib/payroll/expenses";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { getProbationRows } from "@/lib/probation/service";
import { buildRecruitmentOnboardingMetrics } from "@/lib/recruitment/onboarding-metrics";
import { getSalesPlatformMetrics } from "@/lib/sales/service";
import { buildVacationPlatformMetrics } from "@/lib/vacation/metrics";
import { getVacationPlatformMetricRows } from "@/lib/vacation/service";
import { calculateWorkforceStructureSummary } from "@/lib/workforce/seat-lifecycle";

export type PlatformMetrics = {
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
  dataUnavailable: string[];
  communication: {
    failedNotifications: number;
    pendingNotifications: number;
    sentNotifications: number;
    templateReadinessRate: number;
    templatesActive: number;
    templatesReady: number;
    templatesTotal: number;
  };
  expenses: {
    approvedAmount: number;
    reportCount: number;
    totalAmount: number;
    totalRows: number;
  };
  lifecycleRisk: {
    activeContractRenewalRequests: number;
    alerts: LifecycleRiskAlert[];
    contractRiskWindowDays: number;
    expiringContracts: number;
    probationEndings: number;
    probationRiskWindowDays: number;
    probationWorkflowActions: number;
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
  payroll: {
    additions: number;
    batchLabel: string;
    employees: number;
    flags: number;
    governmentDeductions: number;
    gross: number;
    net: number;
    readinessRate: number;
  };
  recruitment: {
    acceptanceRate: number;
    acceptedOffers: number;
    acceptedToEmployeeConversions: number;
    acceptedToEmployeeConversionRate: number;
    hiringDocumentReadinessRate: number;
    hiringDocumentsDue: number;
    hiringDocumentsMissing: number;
    hiringDocumentsPending: number;
    hiringDocumentsSubmitted: number;
    pendingHrApprovalOffers: number;
    pendingOffers: number;
    rejectedOffers: number;
    totalOffers: number;
    vacancyLinkedOffers: number;
    vacancyLinkageRate: number;
  };
  sales: {
    achievementRate: number;
    activeProducts: number;
    dataQualityRate: number;
    salesValue: number;
    targetValue: number;
  };
  workforce: {
    activeEmployees: number;
    employeeHealthRate: number;
    employeesWithoutManagers: number;
    openVacancies: number;
    totalEmployees: number;
    totalStructure: number;
    uniqueAreas: number;
    uniqueLines: number;
  };
};

const emptyPlatformMetrics = (): PlatformMetrics => ({
  attendance: {
    activeMappings: 0,
    activePolicies: 0,
    currentMonthWorkingDays: 0,
    mappingReadinessRate: 1,
    missingDeviceMappings: 0,
    policyCoverageRate: 1,
    totalDeviceMappings: 0,
    totalPolicies: 0,
  },
  dataUnavailable: [],
  communication: {
    failedNotifications: 0,
    pendingNotifications: 0,
    sentNotifications: 0,
    templateReadinessRate: 1,
    templatesActive: 0,
    templatesReady: 0,
    templatesTotal: 0,
  },
  expenses: {
    approvedAmount: 0,
    reportCount: 0,
    totalAmount: 0,
    totalRows: 0,
  },
  lifecycleRisk: {
    activeContractRenewalRequests: 0,
    alerts: [],
    contractRiskWindowDays: 30,
    expiringContracts: 0,
    probationEndings: 0,
    probationRiskWindowDays: 15,
    probationWorkflowActions: 0,
  },
  leave: {
    approvedRequests: 0,
    managerDecisionActions: 0,
    paidDays: 0,
    pendingRequests: 0,
    rejectedRequests: 0,
    totalRequests: 0,
    unpaidDays: 0,
  },
  payroll: {
    additions: 0,
    batchLabel: "No batch",
    employees: 0,
    flags: 0,
    governmentDeductions: 0,
    gross: 0,
    net: 0,
    readinessRate: 1,
  },
  recruitment: {
    acceptanceRate: 0,
    acceptedOffers: 0,
    acceptedToEmployeeConversions: 0,
    acceptedToEmployeeConversionRate: 0,
    hiringDocumentReadinessRate: 1,
    hiringDocumentsDue: 0,
    hiringDocumentsMissing: 0,
    hiringDocumentsPending: 0,
    hiringDocumentsSubmitted: 0,
    pendingHrApprovalOffers: 0,
    pendingOffers: 0,
    rejectedOffers: 0,
    totalOffers: 0,
    vacancyLinkedOffers: 0,
    vacancyLinkageRate: 1,
  },
  sales: {
    achievementRate: 0,
    activeProducts: 0,
    dataQualityRate: 1,
    salesValue: 0,
    targetValue: 0,
  },
  workforce: {
    activeEmployees: 0,
    employeeHealthRate: 1,
    employeesWithoutManagers: 0,
    openVacancies: 0,
    totalEmployees: 0,
    totalStructure: 0,
    uniqueAreas: 0,
    uniqueLines: 0,
  },
});

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

type WorkforceMetricDirectory = {
  employees: Array<Pick<EmployeeDirectoryData["employees"][number], "areaName" | "employmentStatus" | "fullName" | "hrId" | "lineName" | "managerHrId">>;
  lookups: {
    workforceVacancies: Array<{ vacancyCode?: string | null }>;
  };
};

export function canReadCompanyWorkforceAggregates(context: Pick<AccessContext, "role" | "scope" | "source">) {
  if (context.source === "guest" || context.scope === "none") return false;
  return context.scope === "system" || context.role === "Super Admin" || (context.role === "CEO" && context.scope === "company");
}

export function buildCompanyWorkforceAggregateMetrics(directory: WorkforceMetricDirectory): PlatformMetrics["workforce"] {
  const employees = directory.employees.filter((employee) =>
    !isDisposableFixtureText(employee.hrId) && !isDisposableFixtureText(employee.fullName),
  );
  const activeEmployees = employees.filter((employee) =>
    ["active", "on_leave"].includes(String(employee.employmentStatus ?? "").trim().toLowerCase()),
  ).length;
  const totalEmployees = employees.length;
  const openVacancies = directory.lookups.workforceVacancies
    .filter((vacancy) => !isDisposableFixtureText(vacancy.vacancyCode))
    .length;
  const structure = calculateWorkforceStructureSummary({ activeEmployees, openVacancies });

  return {
    activeEmployees: structure.activeEmployees,
    employeeHealthRate: totalEmployees
      ? activeEmployees / totalEmployees
      : 1,
    employeesWithoutManagers: employees.filter((employee) => !employee.managerHrId).length,
    openVacancies: structure.openVacancies,
    totalEmployees,
    totalStructure: structure.totalStructure,
    uniqueAreas: new Set(employees.map((employee) => employee.areaName).filter(Boolean)).size,
    uniqueLines: new Set(employees.map((employee) => employee.lineName).filter(Boolean)).size,
  };
}

export async function getWorkforceMetrics(accessContext: AccessContext): Promise<PlatformMetrics["workforce"]> {
  const canReadEmployeeMaster = await canAccess(accessContext, "employees", "read");
  const canReadCompanyAggregates = canReadCompanyWorkforceAggregates(accessContext);
  if (!canReadEmployeeMaster && !canReadCompanyAggregates) {
    return emptyPlatformMetrics().workforce;
  }

  const directory = await getEmployeeDirectory();
  const metricDirectory = canReadEmployeeMaster
    ? filterEmployeeDirectoryForAccess(directory, accessContext)
    : directory;
  return buildCompanyWorkforceAggregateMetrics(metricDirectory);
}

async function getPayrollMetrics(accessContext: AccessContext): Promise<PlatformMetrics["payroll"]> {
  if (!(await canAccess(accessContext, "payroll", "read"))) {
    return emptyPlatformMetrics().payroll;
  }

  const payroll = await getPayrollDashboard(undefined, accessContext);

  return {
    additions: payroll.summary.totalAdditions,
    batchLabel: payroll.batch ? `${payroll.batch.month}/${payroll.batch.year}` : "No batch",
    employees: payroll.summary.totalEmployees,
    flags: payroll.flags.length,
    governmentDeductions: payroll.summary.totalGovernmentDeductions,
    gross: payroll.summary.totalGross,
    net: payroll.summary.totalNet,
    readinessRate: payroll.summary.readinessRate,
  };
}

async function getSalesMetrics(accessContext: AccessContext): Promise<PlatformMetrics["sales"]> {
  if (!(await canAccess(accessContext, "sales", "read"))) {
    return emptyPlatformMetrics().sales;
  }

  const sales = await getSalesPlatformMetrics(accessContext);

  return {
    achievementRate: numberValue(sales.achievementRate),
    activeProducts: numberValue(sales.activeProducts),
    dataQualityRate: numberValue(sales.dataQualityRate),
    salesValue: numberValue(sales.salesValue),
    targetValue: numberValue(sales.targetValue),
  };
}

async function getExpenseMetrics(accessContext: AccessContext): Promise<PlatformMetrics["expenses"]> {
  if (!(await canAccess(accessContext, "expenses", "read"))) {
    return emptyPlatformMetrics().expenses;
  }

  const metrics = await getPayrollExpenseMetrics(accessContext);

  return {
    approvedAmount: metrics.approvedAmount,
    reportCount: metrics.reportCount,
    totalAmount: metrics.totalAmount,
    totalRows: metrics.totalRows,
  };
}

async function getRecruitmentMetrics(accessContext: AccessContext): Promise<PlatformMetrics["recruitment"]> {
  if (!(await canAccess(accessContext, "offers", "read"))) {
    return emptyPlatformMetrics().recruitment;
  }

  const canReadHiringDocuments = await canAccess(accessContext, "employee_documents", "read");
  const [offers, hiringDocuments] = await Promise.all([
    getOfferDashboard(),
    canReadHiringDocuments
      ? getHiringDocumentsDashboard().catch(() => null)
      : Promise.resolve(null),
  ]);
  const recruitment = buildRecruitmentOnboardingMetrics({
    hiringDocumentDefinitions: hiringDocuments?.documents,
    hiringDocumentEmployees: hiringDocuments?.employees,
    offerRows: offers.rows,
  });

  return {
    acceptanceRate: numberValue(recruitment.acceptanceRate),
    acceptedOffers: recruitment.acceptedOffers,
    acceptedToEmployeeConversions: recruitment.acceptedToEmployeeConversions,
    acceptedToEmployeeConversionRate: numberValue(recruitment.acceptedToEmployeeConversionRate),
    hiringDocumentReadinessRate: numberValue(recruitment.hiringDocuments.readinessRate),
    hiringDocumentsDue: recruitment.hiringDocuments.dueDocuments,
    hiringDocumentsMissing: recruitment.hiringDocuments.missingDocuments,
    hiringDocumentsPending: recruitment.hiringDocuments.pendingDocuments,
    hiringDocumentsSubmitted: recruitment.hiringDocuments.submittedDocuments,
    pendingHrApprovalOffers: recruitment.pendingHrApprovalOffers,
    pendingOffers: recruitment.pendingOffers,
    rejectedOffers: recruitment.rejectedOffers,
    totalOffers: recruitment.totalOffers,
    vacancyLinkedOffers: recruitment.vacancyLinkedOffers,
    vacancyLinkageRate: numberValue(recruitment.vacancyLinkageRate),
  };
}

async function getAttendanceMetrics(accessContext: AccessContext): Promise<PlatformMetrics["attendance"]> {
  if (!(await canAccess(accessContext, "employees", "read"))) {
    return emptyPlatformMetrics().attendance;
  }

  const [deviceMappings, policies] = await Promise.all([
    getAttendanceDeviceUserMappingDashboard(),
    getAttendancePolicyDashboard(),
  ]);
  const today = new Date();
  const monthStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-01`;
  const monthEnd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()).padStart(2, "0")}`;
  const readiness = buildAttendanceReadinessMetrics({
    deviceMappings: deviceMappings.mappings,
    policies: policies.policies,
  });

  return {
    ...readiness,
    currentMonthWorkingDays: countHrWorkingDays(monthStart, monthEnd),
  };
}

async function getLifecycleRiskMetrics(accessContext: AccessContext): Promise<PlatformMetrics["lifecycleRisk"]> {
  const [canReadContracts, canReadProbation] = await Promise.all([
    canAccess(accessContext, "contracts", "read"),
    canAccess(accessContext, "probation", "read"),
  ]);

  const [contracts, probations] = await Promise.all([
    canReadContracts
      ? getContractRenewalDashboardData(accessContext).then((dashboard) => dashboard.rows).catch(() => [])
      : Promise.resolve([]),
    canReadProbation
      ? getProbationRows(accessContext).catch(() => [])
      : Promise.resolve([]),
  ]);

  return buildLifecycleRiskMetrics({
    contracts: contracts.map((row) => ({
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
}

async function getLeaveMetrics(accessContext: AccessContext): Promise<PlatformMetrics["leave"]> {
  if (!(await canAccess(accessContext, "leave", "read"))) {
    return emptyPlatformMetrics().leave;
  }

  const rows = await getVacationPlatformMetricRows(accessContext);
  return buildVacationPlatformMetrics(rows);
}

async function getCommunicationMetrics(accessContext: AccessContext): Promise<PlatformMetrics["communication"]> {
  if (!(await canAccess(accessContext, "admin", "read"))) {
    return emptyPlatformMetrics().communication;
  }

  const [templates, outbox] = await Promise.all([
    getEmailTemplateCatalog(),
    getEmailNotificationOutboxStats(),
  ]);

  return buildCommunicationMetrics({
    outboxRows: [
      ...Array.from({ length: outbox.failed }, () => ({ status: "failed" })),
      ...Array.from({ length: outbox.pending }, () => ({ status: "pending" })),
      ...Array.from({ length: outbox.sent }, () => ({ status: "sent" })),
    ],
    templateRows: templates.map((template) => ({
      bodyHtml: template.bodyHtml,
      bodyText: template.bodyText,
      isActive: template.isActive,
      rules: template.rules,
      subject: template.subject,
      templateKey: template.templateKey,
    })),
  });
}

async function metricOrDefault<T>(
  label: string,
  defaults: T,
  dataUnavailable: string[],
  loader: () => Promise<T>,
) {
  try {
    return await loader();
  } catch {
    dataUnavailable.push(`${label} metrics unavailable.`);
    return defaults;
  }
}

export async function getPlatformMetrics(accessContext: AccessContext): Promise<PlatformMetrics> {
  const defaults = emptyPlatformMetrics();
  const dataUnavailable: string[] = [];

  const [workforce, payroll, sales, expenses, recruitment, attendance, leave, lifecycleRisk, communication] = await Promise.all([
    metricOrDefault("Workforce", defaults.workforce, dataUnavailable, () => getWorkforceMetrics(accessContext)),
    metricOrDefault("Payroll", defaults.payroll, dataUnavailable, () => getPayrollMetrics(accessContext)),
    metricOrDefault("Sales", defaults.sales, dataUnavailable, () => getSalesMetrics(accessContext)),
    metricOrDefault("Expense", defaults.expenses, dataUnavailable, () => getExpenseMetrics(accessContext)),
    metricOrDefault("Recruitment", defaults.recruitment, dataUnavailable, () => getRecruitmentMetrics(accessContext)),
    metricOrDefault("Attendance", defaults.attendance, dataUnavailable, () => getAttendanceMetrics(accessContext)),
    metricOrDefault("Leave", defaults.leave, dataUnavailable, () => getLeaveMetrics(accessContext)),
    metricOrDefault("Lifecycle risk", defaults.lifecycleRisk, dataUnavailable, () => getLifecycleRiskMetrics(accessContext)),
    metricOrDefault("Communication", defaults.communication, dataUnavailable, () => getCommunicationMetrics(accessContext)),
  ]);

  return {
    attendance,
    communication,
    dataUnavailable,
    expenses,
    lifecycleRisk,
    leave,
    payroll,
    recruitment,
    sales,
    workforce,
  };
}
