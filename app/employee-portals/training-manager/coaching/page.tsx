import { redirect } from "next/navigation";

import {
  CoachingAnalyticsDashboard,
  type CoachingAnalyticsFilterOptions,
  type CoachingAnalyticsPayload,
} from "@/components/coaching/coaching-analytics-dashboard";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import {
  canAccess,
  normalizeHrId,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenSkillsSurvey } from "@/lib/coaching/skills-survey/access";
import {
  buildCoachingReportAnalytics,
  buildTrainingManagerCoachingComparison,
  filterCoachingQuarterlySummaryByReports,
} from "@/lib/coaching/analytics";
import {
  getCoachingQuarterlySummary,
  getCoachingReports,
  getCoachingScoreAnalyticsForReports,
} from "@/lib/coaching/service";
import type {
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
} from "@/lib/coaching/types";
import {
  getEmployeeDirectoryRows,
  type EmployeeDirectoryRow,
} from "@/lib/employees/employee-directory";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import { formatEmployeeDisplayName } from "@/lib/utils";

export const dynamic = "force-dynamic";

const skillsSurveyHref = "/employee-portals/coaching-skills-survey";
const fieldCoachingHref = "/employee-portals/training-manager/field-coaching";

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

function buildFilterOptions(
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

export default async function TrainingManagerCoachingDashboardPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }
  if (access.role !== "Training Manager") {
    redirect("/employee-portals");
  }

  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view Training Manager coaching analytics."
        title="Coaching Access Unavailable"
      />
    );
  }

  if (!normalizeHrId(access.hrId)) {
    return (
      <EmployeePortalEmptyState
        message="This Training Manager account needs a linked HR_ID before coaching analytics can be loaded."
        title="Training Manager Profile Unlinked"
      />
    );
  }

  let payload: CoachingAnalyticsPayload | null = null;
  let reports: CoachingReportSummaryRow[] = [];
  let optionReports: CoachingReportSummaryRow[] = [];
  let optionQuarterlySummary: CoachingQuarterlySummaryRow[] = [];
  let visibleQuarterlySummary: CoachingQuarterlySummaryRow[] = [];
  let employees: EmployeeDirectoryRow[] = [];
  const currentYear = new Date().getFullYear();
  const initialReportFilters = { year: currentYear };
  try {
    const [resolvedReports, quarterlySummary, resolvedOptionReports, resolvedOptionQuarterlySummary, resolvedEmployees] = await Promise.all([
      getCoachingReports(initialReportFilters, access),
      getCoachingQuarterlySummary(initialReportFilters, access),
      getCoachingReports({}, access),
      getCoachingQuarterlySummary({}, access),
      getEmployeeDirectoryRows(),
    ]);
    reports = resolvedReports;
    optionReports = resolvedOptionReports;
    optionQuarterlySummary = resolvedOptionQuarterlySummary;
    employees = resolvedEmployees;
    visibleQuarterlySummary = filterCoachingQuarterlySummaryByReports(quarterlySummary, reports, true);
    const scoreAnalytics = await getCoachingScoreAnalyticsForReports(reports);
    payload = {
      analytics: buildCoachingReportAnalytics(reports),
      ...scoreAnalytics,
      quarterlySummary: visibleQuarterlySummary,
      reports,
      trainingManagerComparison: buildTrainingManagerCoachingComparison({
        employees,
        reports,
      }),
    };
  } catch {
    return (
      <EmployeePortalEmptyState
        message="Unable to load Training Manager coaching analytics. Please try again later."
        title="Coaching Dashboard Unavailable"
      />
    );
  }

  // The old coaching form takes no new reports (owner, 2026-10-31); its button now opens the survey.
  const showSkillsSurveyLink =
    canOpenSkillsSurvey(access) && (await canAccess(access, "coaching_skills_survey", "read"));

  return (
    <EmployeePortalPageShell
      badge="Coaching"
      description="Track field coaching performance, development progress, and quarterly improvement trends without leaving the employee portal."
      title="Coaching Analytics"
    >
      <EmployeePortalActionBar
        actions={
          <>
            <EmployeePortalActionLink href={fieldCoachingHref} label="Back to Reports Center" />
            {showSkillsSurveyLink ? (
              <EmployeePortalActionLink href={skillsSurveyHref} label="Team Coaching Skills Survey" />
            ) : null}
          </>
        }
      />

      <CoachingAnalyticsDashboard
        showSkillsSurveyLink={showSkillsSurveyLink}
        skillsSurveyHref={skillsSurveyHref}
        filterOptions={buildFilterOptions(optionReports, optionQuarterlySummary, employees)}
        initialFilters={{ year: String(currentYear) }}
        initialData={payload}
      />
    </EmployeePortalPageShell>
  );
}
