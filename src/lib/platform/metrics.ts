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
import { canonicalHrIdKey } from "@/lib/hr-id";
import { getHiringDocumentsDashboard } from "@/lib/hiring-documents/service";
import { buildLifecycleRiskMetrics, type LifecycleRiskAlert } from "@/lib/lifecycle-risk/metrics";
import { getEmailNotificationOutboxStats } from "@/lib/notifications/email";
import { getPayrollExpenseMetrics } from "@/lib/outstation/expenses";
import { getPayrollDashboard } from "@/lib/payroll/service";
import { getProbationRows } from "@/lib/probation/service";
import { buildRecruitmentOnboardingMetrics } from "@/lib/recruitment/onboarding-metrics";
import { classifyOrganogramStructureLevel, seatOccupancyKey } from "@/lib/reports/organogram-safety";
import { getSalesPlatformMetrics } from "@/lib/sales/service";
import { buildVacationPlatformMetrics } from "@/lib/vacation/metrics";
import { getVacationPlatformMetricRows } from "@/lib/vacation/service";
import { calculateWorkforceStructureSummary } from "@/lib/workforce/seat-lifecycle";

/**
 * A rate that was NEVER COMPUTED reads `null`, not a number.
 *
 * Every one of these used to default to 1 — a clean 100% — and `emptyPlatformMetrics()` is
 * returned for THREE different reasons: the read threw, the viewer has no permission for that
 * module, or the population is empty. In the first two the figure does not exist, and a fabricated
 * all-clear is the worst possible substitute: it is the number a manager would act on, and it says
 * exactly what he wants to hear. `null` forces every surface to render "—" instead, and to say so.
 *
 * The permission case is the one that had no signal at all: `dataUnavailable` is appended only
 * from `metricOrDefault`'s catch, so a section the viewer simply cannot read reached the page as
 * 100% with an EMPTY unavailable list — nothing, anywhere, marked it as not-read.
 */
export type UncomputedRate = number | null;

export type PlatformMetrics = {
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
  dataUnavailable: string[];
  communication: {
    failedNotifications: number;
    pendingNotifications: number;
    sentNotifications: number;
    templateReadinessRate: UncomputedRate;
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
    readinessRate: UncomputedRate;
  };
  recruitment: {
    hiringDocumentReadinessRate: UncomputedRate;
    hiringDocumentsDue: number;
    hiringDocumentsMissing: number;
    hiringDocumentsPending: number;
    hiringDocumentsSubmitted: number;
  };
  sales: {
    achievementRate: UncomputedRate;
    activeProducts: number;
    dataQualityRate: UncomputedRate;
    salesValue: number;
    targetValue: number;
  };
  workforce: {
    activeEmployees: number;
    employeeHealthRate: UncomputedRate;
    employeesWithoutManagers: number;
    openVacancies: number;
    totalEmployees: number;
    totalStructure: number;
    uniqueAreas: number;
    uniqueLines: number;
  };
};

/**
 * The shape returned when a section could NOT be measured. Counts stay 0 — "no rows read" and
 * "zero rows" look the same in a count, and a 0 invites a look rather than closing the question.
 * Rates are `null`, because a rate is a JUDGEMENT and there is nothing here to judge.
 *
 * Note what is deliberately NOT here: a `dataUnavailable` entry for the permission case. A viewer
 * without payroll access is not looking at a broken page, and putting "Payroll data unavailable"
 * in front of every non-payroll role would train all of them to ignore the notice that matters.
 * The `null` alone is what stops the fabricated all-clear; the surfaces render "—".
 *
 * Exported so `tests/platform-metrics.test.ts` can assert the rates directly. A regex over this
 * source would pass the day someone reintroduced a `1` two functions away; reading the object is
 * the only check that cannot.
 */
export const emptyPlatformMetrics = (): PlatformMetrics => ({
  attendance: {
    activeMappings: 0,
    activePolicies: 0,
    currentMonthWorkingDays: 0,
    mappingReadinessRate: null,
    missingDeviceMappings: 0,
    policyCoverageRate: null,
    totalDeviceMappings: 0,
    totalPolicies: 0,
  },
  dataUnavailable: [],
  communication: {
    failedNotifications: 0,
    pendingNotifications: 0,
    sentNotifications: 0,
    templateReadinessRate: null,
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
    readinessRate: null,
  },
  recruitment: {
    hiringDocumentReadinessRate: null,
    hiringDocumentsDue: 0,
    hiringDocumentsMissing: 0,
    hiringDocumentsPending: 0,
    hiringDocumentsSubmitted: 0,
  },
  sales: {
    achievementRate: null,
    activeProducts: 0,
    dataQualityRate: null,
    salesValue: 0,
    targetValue: 0,
  },
  workforce: {
    activeEmployees: 0,
    employeeHealthRate: null,
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

/**
 * The same coercion for a RATE, which must never fall back to a number. `numberValue` turning an
 * absent rate into 0 is the identical defect to defaulting it to 1, pointing the other way: both
 * print a verdict nobody measured.
 */
function rateValue(value: unknown): UncomputedRate {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// A fixed structural seat, in the shape the organogram's own occupancy key reads.
// Every field is optional so an employee directory row and a position_vacancies
// lookup row can both be passed straight through without a per-caller adapter.
type WorkforceSeatRow = {
  areaName?: string | null;
  jobTitle?: string | null;
  lineName?: string | null;
  managerHrId?: string | null;
  managerName?: string | null;
  positionTitle?: string | null;
};

type WorkforceVacancySeatRow = WorkforceSeatRow & {
  // Two distinct position_vacancies columns carry the seat-continuity marker and
  // callers expose different ones — the organogram row model surfaces
  // manager_replacement_for_hr_id, the employee-directory lookup surfaces
  // replacement_for_hr_id. Reading only one of them silently drops the marker for
  // the other caller and hides a seat that is genuinely placeable.
  managerReplacementForHrId?: string | null;
  replacementForHrId?: string | null;
  vacancyCode?: string | null;
};

type WorkforceMetricDirectory = {
  employees: Array<
    Pick<EmployeeDirectoryData["employees"][number], "areaName" | "employmentStatus" | "fullName" | "hrId" | "lineName" | "managerHrId"> &
      WorkforceSeatRow
  >;
  lookups: {
    workforceVacancies: WorkforceVacancySeatRow[];
  };
};

function organogramSeat(row: WorkforceSeatRow) {
  return {
    areaName: row.areaName ?? null,
    jobTitle: row.jobTitle ?? null,
    lineName: row.lineName ?? null,
    managerHrId: row.managerHrId ?? null,
    managerName: row.managerName ?? null,
    positionTitle: row.positionTitle ?? null,
  };
}

/**
 * Open vacancies collapsed to DISTINCT UNOCCUPIED SEATS — the same figure the
 * Organogram and the Vacancy Report show.
 *
 * `position_vacancies` stores one row per vacancy EVENT, not one per seat. A seat
 * that emptied twice carries two open rows, and a seat an active employee has
 * since taken keeps its stale open row because the hire path only closes a
 * vacancy it can positively match. Counting rows therefore inflates the number —
 * in production 45 open rows stand for 33 real seats, 7 of those rows sitting on
 * seats somebody already occupies — and every "total structure" derived from it
 * inherits the inflation. Occupancy decides filled-vs-vacant here, never the
 * mutable `status` column, which is why the key comes from organogram-safety
 * instead of a third private copy of the same rule.
 */
export function countUnoccupiedWorkforceSeats(input: {
  employees: WorkforceSeatRow[];
  vacancies: WorkforceVacancySeatRow[];
}) {
  return listUnoccupiedWorkforceSeats(input).length;
}

/**
 * The same rule, returning the SEATS rather than how many there are.
 *
 * Added 2026-09-01 for the HR landing page, which needs the deduped rows themselves: its
 * "Seats Not Recruited" tile subtracts open requisitions from open seats, and subtracting from
 * the raw `position_vacancies` list would have carried the inflation described above straight
 * into the answer. `countUnoccupiedWorkforceSeats` is now `.length` of this, so the two can
 * never drift — the defect this docblock records is a defect precisely because the rule had
 * more than one implementation.
 */
export function listUnoccupiedWorkforceSeats<V extends WorkforceVacancySeatRow>(input: {
  employees: WorkforceSeatRow[];
  vacancies: readonly V[];
}): V[] {
  const occupiedSeatKeys = new Set<string>();
  for (const employee of input.employees) {
    const key = seatOccupancyKey(organogramSeat(employee));
    if (key) occupiedSeatKeys.add(key);
  }

  const countedSeatKeys = new Set<string>();
  const countedVacancyCodes = new Set<string>();
  const openSeats: V[] = [];

  for (const vacancy of input.vacancies) {
    const seat = organogramSeat(vacancy);
    const level = classifyOrganogramStructureLevel(seat);

    // A vacant DSM/RSM/NSM seat has to report to a known manager to be placeable
    // in the structure; one with neither a manager nor a seat-continuity marker is
    // orphaned import debris that the organogram hides, so counting it here would
    // put the tile back above the chart it is supposed to agree with.
    const isManagerSeat = level === "dsm" || level === "nsm" || level === "rsm";
    const seatContinuityHrId =
      vacancy.managerReplacementForHrId ?? vacancy.replacementForHrId ?? "";
    if (isManagerSeat && !String(vacancy.managerHrId ?? "").trim() && !String(seatContinuityHrId).trim()) {
      continue;
    }

    const seatKey = seatOccupancyKey(seat);
    if (seatKey) {
      if (occupiedSeatKeys.has(seatKey) || countedSeatKeys.has(seatKey)) continue;
      countedSeatKeys.add(seatKey);
      openSeats.push(vacancy);
      continue;
    }

    // No resolvable seat — a non-sales role such as a Head Office position, or a
    // row missing area/line/manager. Those are never suppressed on a guess, only
    // deduped by code, so a genuinely under-specified vacancy still counts once.
    const vacancyCode = String(vacancy.vacancyCode ?? "").trim().toUpperCase();
    if (vacancyCode) {
      if (countedVacancyCodes.has(vacancyCode)) continue;
      countedVacancyCodes.add(vacancyCode);
    }
    openSeats.push(vacancy);
  }

  return openSeats;
}

export function canReadCompanyWorkforceAggregates(context: Pick<AccessContext, "role" | "scope" | "source">) {
  if (context.source === "guest" || context.scope === "none") return false;
  return context.scope === "system" || context.role === "Super Admin" || (context.role === "CEO" && context.scope === "company");
}

export function canReadCompanyAttendanceAggregates(context: Pick<AccessContext, "role" | "scope" | "source">) {
  if (context.source === "guest" || context.scope === "none") return false;
  return context.scope === "system" || context.role === "Super Admin" || (context.role === "CEO" && context.scope === "company");
}

export function canReadCompanyRecruitmentAggregates(context: Pick<AccessContext, "role" | "scope" | "source">) {
  if (context.source === "guest" || context.scope === "none") return false;
  return context.scope === "system" || context.role === "Super Admin" || (context.role === "CEO" && context.scope === "company");
}

export function buildCompanyWorkforceAggregateMetrics(directory: WorkforceMetricDirectory): PlatformMetrics["workforce"] {
  const employees = directory.employees.filter((employee) =>
    !isDisposableFixtureText(employee.hrId) && !isDisposableFixtureText(employee.fullName),
  );
  const activeEmployeeRows = employees.filter((employee) =>
    ["active", "on_leave"].includes(String(employee.employmentStatus ?? "").trim().toLowerCase()),
  );
  const activeEmployees = activeEmployeeRows.length;
  const totalEmployees = employees.length;
  // Only ACTIVE employees may mark a seat occupied — a resigned person's seat has
  // to stay countable as vacant, which is the whole point of keying on occupancy.
  const openVacancies = countUnoccupiedWorkforceSeats({
    employees: activeEmployeeRows,
    vacancies: directory.lookups.workforceVacancies.filter(
      (vacancy) => !isDisposableFixtureText(vacancy.vacancyCode),
    ),
  });
  const structure = calculateWorkforceStructureSummary({ activeEmployees, openVacancies });

  return {
    activeEmployees: structure.activeEmployees,
    // No employees read means no health to report. 1 here would have said "every employee is
    // fine" about a population nobody counted.
    employeeHealthRate: totalEmployees ? activeEmployees / totalEmployees : null,
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
    achievementRate: rateValue(sales.achievementRate),
    activeProducts: numberValue(sales.activeProducts),
    dataQualityRate: rateValue(sales.dataQualityRate),
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
  const canReadCompanyAggregates = canReadCompanyRecruitmentAggregates(accessContext);
  const canReadHiringDocuments = await canAccess(accessContext, "employee_documents", "read");
  if (!canReadHiringDocuments && !canReadCompanyAggregates) {
    return emptyPlatformMetrics().recruitment;
  }

  const hiringDocuments = await getHiringDocumentsDashboard().catch(() => null);
  const recruitment = buildRecruitmentOnboardingMetrics({
    hiringDocumentDefinitions: hiringDocuments?.documents,
    hiringDocumentEmployees: hiringDocuments?.employees,
  });

  return {
    hiringDocumentReadinessRate: rateValue(recruitment.hiringDocuments.readinessRate),
    hiringDocumentsDue: recruitment.hiringDocuments.dueDocuments,
    hiringDocumentsMissing: recruitment.hiringDocuments.missingDocuments,
    hiringDocumentsPending: recruitment.hiringDocuments.pendingDocuments,
    hiringDocumentsSubmitted: recruitment.hiringDocuments.submittedDocuments,
  };
}

async function getAttendanceMetrics(accessContext: AccessContext): Promise<PlatformMetrics["attendance"]> {
  const [canReadAttendance, canReadEmployeeMaster] = await Promise.all([
    canAccess(accessContext, "attendance", "read"),
    canAccess(accessContext, "employees", "read"),
  ]);
  const canReadCompanyAggregates = canReadCompanyAttendanceAggregates(accessContext);
  if (!canReadAttendance && !canReadEmployeeMaster && !canReadCompanyAggregates) {
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

  const [contracts, probations, directory] = await Promise.all([
    canReadContracts
      ? getContractRenewalDashboardData(accessContext).then((dashboard) => dashboard.rows).catch(() => [])
      : Promise.resolve([]),
    canReadProbation
      ? getProbationRows(accessContext).catch(() => [])
      : Promise.resolve([]),
    getEmployeeDirectory(),
  ]);
  const displayNameByHrId = new Map(
    directory.employees.map((employee) => [canonicalHrIdKey(employee.hrId), employee.displayName]),
  );

  return buildLifecycleRiskMetrics({
    contracts: contracts.map((row) => ({
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
