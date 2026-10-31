import { BarChart3, ClipboardCheck, ListChecks } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import {
  AdminInsightChip,
  AdminPageHero,
} from "@/components/admin/admin-design-system";
import {
  CoachingAnalyticsDashboard,
  type CoachingAnalyticsPayload,
} from "@/components/coaching/coaching-analytics-dashboard";
import {
  canAccess,
  type AccessContext,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canOpenSkillsSurvey } from "@/lib/coaching/skills-survey/access";
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

export const dynamic = "force-dynamic";

function isEmployeePortalRole(access: AccessContext) {
  return access.role === "Employee" || access.role === "Medical Rep";
}

export default async function CoachingAnalyticsPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) {
    redirect("/login");
  }
  if (access.role === "Training Manager") {
    redirect("/employee-portals/training-manager");
  }
  if (isEmployeePortalRole(access)) {
    redirect("/employee-portals/coaching");
  }
  if (!(await canAccess(access, "coaching", "read"))) {
    redirect("/admin/access");
  }

  // The old coaching form takes no new reports (owner, 2026-10-31); its button now opens the survey.
  const showSkillsSurveyLink =
    canOpenSkillsSurvey(access) && (await canAccess(access, "coaching_skills_survey", "read"));

  const currentYear = new Date().getFullYear();
  const initialReportFilters = { year: currentYear };

  const [reports, quarterlySummary, optionReports, optionQuarterlySummary, directory] = await Promise.all([
    getCoachingReports(initialReportFilters, access),
    getCoachingQuarterlySummary(initialReportFilters, access),
    getCoachingReports({}, access),
    getCoachingQuarterlySummary({}, access),
    getEmployeeDirectoryRows(),
  ]);
  // The rep comparison and the filter options are built from the directory, so it is narrowed by
  // the same rule as the reports — the whole company here listed every line's reps as uncoached to
  // a line or team manager (owner, 2026-10-20). Oversight roles keep the full directory.
  const employees = scopeCoachingDirectoryForAccess(access, directory);

  const visibleQuarterlySummary = filterCoachingQuarterlySummaryByReports(quarterlySummary, reports, true);
  const scoreAnalytics = await getCoachingScoreAnalyticsForReports(reports);
  const payload: CoachingAnalyticsPayload = {
    analytics: buildCoachingReportAnalytics(reports),
    ...scoreAnalytics,
    quarterlySummary: visibleQuarterlySummary,
    reports,
    trainingManagerComparison: buildTrainingManagerCoachingComparison({
      employees,
      reports,
    }),
  };

  return (
    <div className="space-y-6">
      <AdminPageHero
        actions={
            <div className="flex flex-wrap gap-2">
              <Link
                className="inline-flex items-center justify-center gap-2 rounded-full border border-phx-line-strong bg-white px-5 py-2.5 text-sm font-black text-phx-ink shadow-sm transition hover:border-phx-accent/50 hover:text-phx-accent"
                href="/coaching"
              >
                <ClipboardCheck className="h-4 w-4" />
                Back to Reports Center
              </Link>
              {showSkillsSurveyLink ? (
                <Link
                  className="inline-flex items-center justify-center gap-2 rounded-full bg-phx-accent px-5 py-2.5 text-sm font-black text-white shadow-[0_18px_42px_rgba(249,115,22,0.22)] transition hover:bg-phx-accent-hover"
                  href="/coaching/skills-survey"
                >
                  <ListChecks className="h-4 w-4" />
                  Team Coaching Skills Survey
                </Link>
              ) : null}
            </div>
          }
          badges={
            <div className="flex flex-wrap gap-2">
              <AdminInsightChip>Quarterly intelligence</AdminInsightChip>
              <AdminInsightChip tone="orange">Field Excellence</AdminInsightChip>
              <AdminInsightChip tone="slate">Development progress</AdminInsightChip>
            </div>
          }
          description="Track field coaching performance, development progress, and quarterly improvement trends."
          eyebrow="Coaching"
          icon={<BarChart3 className="h-3.5 w-3.5" />}
          title="Coaching Analytics"
        />

        <CoachingAnalyticsDashboard
          showSkillsSurveyLink={showSkillsSurveyLink}
          filterOptions={buildCoachingAnalyticsFilterOptions(optionReports, optionQuarterlySummary, employees)}
          initialFilters={{ year: String(currentYear) }}
          initialData={payload}
        />
    </div>
  );
}
