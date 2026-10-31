import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import {
  CoachingAnalyticsDashboard,
  type CoachingAnalyticsPayload,
} from "@/components/coaching/coaching-analytics-dashboard";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  buildCoachingReportAnalytics,
  buildTrainingManagerCoachingComparison,
  filterCoachingQuarterlySummaryByReports,
} from "@/lib/coaching/analytics";
import { buildCoachingAnalyticsFilterOptions } from "@/lib/coaching/analytics-options";
import {
  getCoachingQuarterlySummary,
  getCoachingReports,
  getCoachingScoreAnalyticsForReports,
  scopeCoachingDirectoryForAccess,
} from "@/lib/coaching/service";
import { getEmployeeDirectoryRows } from "@/lib/employees/employee-directory";
import { resolveLandingPathForRole } from "@/lib/auth/landing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales Intelligence section is Product / Group Product Managers only. Coaching reports
// are auto-scoped to the viewer's line + department inside getCoachingReports
// (filterSummariesForAccess), so PM/GPM see only their own line.
const COACHING_ANALYTICS_PORTAL_ROLES = new Set(["Product Manager", "Group Product Manager", "Marketing Manager"]);

export default async function PortalCoachingAnalyticsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (
    !COACHING_ANALYTICS_PORTAL_ROLES.has(access.role) ||
    !(await canAccess(access, "coaching", "read"))
  ) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const currentYear = new Date().getFullYear();
  const initialReportFilters = { year: currentYear };

  const [reports, quarterlySummary, optionReports, optionQuarterlySummary, employees] = await Promise.all([
    getCoachingReports(initialReportFilters, access),
    getCoachingQuarterlySummary(initialReportFilters, access),
    getCoachingReports({}, access),
    getCoachingQuarterlySummary({}, access),
    getEmployeeDirectoryRows(),
  ]);

  const visibleQuarterlySummary = filterCoachingQuarterlySummaryByReports(quarterlySummary, reports, true);
  const scoreAnalytics = await getCoachingScoreAnalyticsForReports(reports);
  // PM/GPM are line-scoped: getCoachingReports already filters the per-rep reports to the viewer's
  // line, but the full directory would otherwise leak every line into the Training-Manager coverage
  // comparison and the line/area filter options. Scope the directory with the SAME canonical coaching
  // access rule so the whole page stays within the viewer's line — the one helper the admin page and
  // the analytics API share (owner, 2026-10-20).
  const scopedEmployees = scopeCoachingDirectoryForAccess(access, employees);
  const payload: CoachingAnalyticsPayload = {
    analytics: buildCoachingReportAnalytics(reports),
    ...scoreAnalytics,
    quarterlySummary: visibleQuarterlySummary,
    reports,
    trainingManagerComparison: buildTrainingManagerCoachingComparison({
      employees: scopedEmployees,
      reports,
    }),
  };

  return (
    <EmployeePortalPageShell
      badge="Sales Intelligence"
      description="Field coaching performance for your line — coverage, average scores by zone, and per-rep development trends."
      errorBoundaryTitle="Coaching Analytics unavailable"
      title="Coaching Analytics"
    >
      <CoachingAnalyticsDashboard
        showSkillsSurveyLink={false}
        filterOptions={buildCoachingAnalyticsFilterOptions(optionReports, optionQuarterlySummary, scopedEmployees)}
        initialFilters={{ year: String(currentYear) }}
        initialData={payload}
      />
    </EmployeePortalPageShell>
  );
}
