import type { CoachingAnalyticsFilterOptions } from "@/components/coaching/coaching-analytics-dashboard";
import type {
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import type { EmployeeDirectoryRow } from "@/lib/employees/employee-directory";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { formatEmployeeDisplayName } from "@/lib/utils";

function toOptionMap(
  rows: { label: string | null | undefined; value: number | string | null | undefined }[],
) {
  const options = new Map<string, string>();
  for (const row of rows) {
    if (row.value === null || typeof row.value === "undefined") continue;
    const value = String(row.value);
    const label = row.label?.trim() || value;
    if (!options.has(value)) options.set(value, label);
  }
  return [...options.entries()]
    .map(([value, label]) => ({ label, value }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

/**
 * Build the filter dropdown options for the coaching analytics dashboard from the
 * (already access-scoped) reports, quarterly summary, and employee directory. Shared
 * by the admin Coaching Analytics page and the employee-portal Coaching Analytics page
 * so both surfaces present identical, consistent filter choices.
 */
export function buildCoachingAnalyticsFilterOptions(
  reports: CoachingReportSummaryRow[],
  quarterlySummary: CoachingQuarterlySummaryRow[],
  employees: EmployeeDirectoryRow[],
): CoachingAnalyticsFilterOptions {
  return {
    areas: toOptionMap([
      ...employees.map((employee) => ({ label: employee.areaName, value: employee.areaId })),
      ...reports.map((report) => ({ label: report.areaName, value: report.areaId })),
    ]),
    lines: toOptionMap([
      ...employees.map((employee) => ({ label: employee.lineName, value: employee.lineId })),
      ...reports.map((report) => ({ label: report.lineName, value: report.lineId })),
    ]),
    medicalReps: toOptionMap([
      ...employees.map((employee) => ({
        label: `${formatEmployeeDisplayName(employee.displayName, employee.hrId)} (${formatHrIdForDisplay(employee.hrId) ?? employee.hrId})`,
        value: employee.hrId,
      })),
      ...reports.map((report) => ({
        label: `${formatEmployeeDisplayName(report.medicalRepName, report.medicalRepHrId)} (${formatHrIdForDisplay(report.medicalRepHrId) ?? report.medicalRepHrId})`,
        value: report.medicalRepHrId,
      })),
    ]),
    teams: toOptionMap(reports.map((report) => ({
      label: report.teamName || (report.teamId ? `Team ${report.teamId}` : null),
      value: report.teamId,
    }))),
    years: toOptionMap([
      ...reports.map((report) => ({ label: String(report.coachingYear), value: report.coachingYear })),
      ...quarterlySummary.map((row) => ({ label: String(row.year), value: row.year })),
      { label: String(new Date().getFullYear()), value: new Date().getFullYear() },
    ]).sort((left, right) => Number(right.value) - Number(left.value)),
  };
}
