import { addDaysToDateOnly, daysBetweenDateOnly, parseDateOnly } from "@/lib/date-only";
import { nextContractAnniversary } from "@/lib/contracts/date-rules";
import { currentCairoDateParts } from "@/lib/i18n/format";
import type { ContractRenewalStatus } from "@/lib/contracts/types";
import type { ProbationDecision, ProbationZone } from "@/lib/probation/types";

export const lifecycleRiskWindows = {
  contractCriticalDays: 7,
  contractRiskDays: 30,
  contractUpcomingDays: 60,
  probationCriticalDays: 30,
  probationDays: 90,
  probationRiskDays: 15,
  probationWarningDays: 60,
} as const;

export type LifecycleRiskAlert = {
  date: string;
  days: number;
  employeeHrId: string | null;
  name: string;
  type: "contract" | "probation";
};

export type ContractRiskInput = {
  contractRenewalDate: string | null;
  employeeHrId?: string | null;
  employeeName?: string | null;
  workflowStatus?: ContractRenewalStatus | null;
};

export type ProbationRiskInput = {
  daysRemaining?: number | null;
  employeeHrId?: string | null;
  employeeName?: string | null;
  hireDate?: string | null;
  /** The probation ended with no decision (a tracker row's `overdue_decision`). */
  overdueDecision?: boolean;
  probationEndDate?: string | null;
  workflowDecision?: ProbationDecision | null;
};

const activeContractRequestStatuses: ContractRenewalStatus[] = ["requested", "manager_review", "hr_review"];

// Resolves which CALENDAR DAY `referenceDate` falls on in Africa/Cairo (not the server's own
// UTC clock — Cairo is ahead of UTC, so near Cairo midnight the two disagree on "today"), then
// builds a Date for that day using the same local-constructor convention date-only.ts's
// parseDateOnly uses, so the two stay directly comparable via getTime().
function startOfToday(referenceDate = new Date()) {
  const { year, month, day } = currentCairoDateParts(referenceDate);
  return new Date(year, month - 1, day);
}

export function daysUntilLifecycleDate(value: string | null | undefined, referenceDate = new Date()) {
  const target = parseDateOnly(value);
  if (!target) return null;
  return Math.ceil((target.getTime() - startOfToday(referenceDate).getTime()) / 86400000);
}

export function isDateWithinLifecycleRiskWindow(
  value: string | null | undefined,
  days: number,
  referenceDate = new Date(),
) {
  const daysUntil = daysUntilLifecycleDate(value, referenceDate);
  return daysUntil !== null && daysUntil >= 0 && daysUntil <= days;
}

export function probationEndDateFromHire(hireDate: string | null | undefined) {
  return addDaysToDateOnly(hireDate, lifecycleRiskWindows.probationDays);
}

export function classifyContractRenewalRisk(daysUntilRenewal: number | null) {
  if (daysUntilRenewal === null) return "missing" as const;
  if (daysUntilRenewal < 0) return "healthy" as const;
  if (daysUntilRenewal <= lifecycleRiskWindows.contractCriticalDays) return "critical" as const;
  if (daysUntilRenewal <= lifecycleRiskWindows.contractRiskDays) return "warning" as const;
  if (daysUntilRenewal <= lifecycleRiskWindows.contractUpcomingDays) return "upcoming" as const;
  return "healthy" as const;
}

export function classifyProbationTrafficStatus(daysRemaining: number) {
  if (daysRemaining > lifecycleRiskWindows.probationWarningDays) return "safe" as const;
  if (daysRemaining >= lifecycleRiskWindows.probationCriticalDays) return "warning" as const;
  return "critical" as const;
}

/**
 * The tracker's zone for one row: a probation that ended with no decision is its own zone, above
 * critical, whatever its (zero or negative) day count would classify as.
 */
export function classifyProbationRowZone(row: {
  days_remaining: number;
  overdue_decision?: boolean;
}): ProbationZone {
  return row.overdue_decision ? "overdue" : classifyProbationTrafficStatus(row.days_remaining);
}

export function calculateProbationProgress(daysRemaining: number) {
  return Math.max(
    0,
    Math.min(100, Math.round(((lifecycleRiskWindows.probationDays - Math.max(0, daysRemaining)) / lifecycleRiskWindows.probationDays) * 100)),
  );
}

export function resolveEmployeeLifecycleJourney(input: {
  contractRenewalDate?: string | null;
  contractSignedDate?: string | null;
  hireDate?: string | null;
}, referenceDate = new Date()) {
  const hireDate = input.hireDate ?? null;
  const probationEndDate = probationEndDateFromHire(hireDate);
  const contractRenewalDate = input.contractRenewalDate ?? nextContractAnniversary(hireDate, referenceDate);
  const daysUntilRenewal = daysUntilLifecycleDate(contractRenewalDate, referenceDate);
  const daysUntilProbationEnd = daysUntilLifecycleDate(probationEndDate, referenceDate);

  return {
    contractRenewalDate,
    contractSignedDate: input.contractSignedDate ?? hireDate,
    daysUntilProbationEnd,
    daysUntilRenewal,
    hireDate,
    probationActive: daysUntilProbationEnd !== null && daysUntilProbationEnd > 0,
    probationEndDate,
    renewalRisk: classifyContractRenewalRisk(daysUntilRenewal),
    serviceDurationDays: Math.max(0, daysBetweenDateOnly(hireDate, referenceDate) ?? 0),
  };
}

export function summarizeContractRenewalRows(rows: ContractRiskInput[], referenceDate = new Date()) {
  return {
    activeRequests: rows.filter((row) => row.workflowStatus && activeContractRequestStatuses.includes(row.workflowStatus)).length,
    dueIn7Days: rows.filter((row) =>
      isDateWithinLifecycleRiskWindow(row.contractRenewalDate, lifecycleRiskWindows.contractCriticalDays, referenceDate),
    ).length,
    dueIn30Days: rows.filter((row) =>
      isDateWithinLifecycleRiskWindow(row.contractRenewalDate, lifecycleRiskWindows.contractRiskDays, referenceDate),
    ).length,
    hrReview: rows.filter((row) => row.workflowStatus === "hr_review").length,
    managerReview: rows.filter((row) => row.workflowStatus === "manager_review").length,
    notRenewed: rows.filter((row) => row.workflowStatus === "not_renewed").length,
    renewed: rows.filter((row) => row.workflowStatus === "renewed").length,
    totalRenewals: rows.length,
    totalRequests: rows.filter((row) => Boolean(row.workflowStatus)).length,
  };
}

export function summarizeProbationRiskRows(rows: ProbationRiskInput[]) {
  const activeRows = rows.filter((row) => row.workflowDecision !== "pass" && row.workflowDecision !== "terminate");
  // An overdue-decision row sits in its own zone, so the three day-count zones never also count it.
  const zoneRows = activeRows.filter((row) => !row.overdueDecision);
  return {
    critical: zoneRows.filter((row) => classifyProbationTrafficStatus(Number(row.daysRemaining ?? 0)) === "critical").length,
    openWorkflows: activeRows.filter((row) => row.workflowDecision == null).length,
    overdue: activeRows.length - zoneRows.length,
    safe: zoneRows.filter((row) => classifyProbationTrafficStatus(Number(row.daysRemaining ?? 0)) === "safe").length,
    total: activeRows.length,
    warning: zoneRows.filter((row) => classifyProbationTrafficStatus(Number(row.daysRemaining ?? 0)) === "warning").length,
  };
}

export function buildLifecycleRiskMetrics(input: {
  contracts?: ContractRiskInput[];
  probations?: ProbationRiskInput[];
  referenceDate?: Date;
}) {
  const referenceDate = input.referenceDate ?? new Date();
  const contracts = input.contracts ?? [];
  const probations = input.probations ?? [];
  const alerts: LifecycleRiskAlert[] = [];

  for (const contract of contracts) {
    const date = contract.contractRenewalDate;
    const days = daysUntilLifecycleDate(date, referenceDate);
    if (!date || days === null || days < 0 || days > lifecycleRiskWindows.contractRiskDays) continue;
    alerts.push({
      date,
      days,
      employeeHrId: contract.employeeHrId ?? null,
      name: contract.employeeName ?? "Unknown employee",
      type: "contract",
    });
  }

  for (const probation of probations) {
    const date = probation.probationEndDate ?? probationEndDateFromHire(probation.hireDate);
    const days = probation.daysRemaining ?? daysUntilLifecycleDate(date, referenceDate);
    if (!date || days === null || days < 0 || days > lifecycleRiskWindows.probationRiskDays) continue;
    if (probation.workflowDecision === "pass" || probation.workflowDecision === "terminate") continue;
    alerts.push({
      date,
      days,
      employeeHrId: probation.employeeHrId ?? null,
      name: probation.employeeName ?? "Unknown employee",
      type: "probation",
    });
  }

  const contractSummary = summarizeContractRenewalRows(contracts, referenceDate);
  const probationSummary = summarizeProbationRiskRows(probations);

  return {
    activeContractRenewalRequests: contractSummary.activeRequests,
    alerts: alerts.sort((left, right) => left.days - right.days || left.name.localeCompare(right.name)),
    contractRiskWindowDays: lifecycleRiskWindows.contractRiskDays,
    expiringContracts: alerts.filter((alert) => alert.type === "contract").length,
    probationEndings: alerts.filter((alert) => alert.type === "probation").length,
    probationRiskWindowDays: lifecycleRiskWindows.probationRiskDays,
    probationWorkflowActions: probationSummary.openWorkflows,
  };
}
