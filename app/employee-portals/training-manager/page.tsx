import { redirect } from "next/navigation";

import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { TrainingManagerCoachingDashboard } from "@/components/employee-portal/training-manager-coaching";
import {
  canAccess,
  normalizeHrId,
  resolveNavigationMode,
} from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  getCoachingQuarterlySummary,
  getCoachingReports,
  getCoachingScoreAnalyticsForReports,
} from "@/lib/coaching/service";
import type {
  CoachingQuarterlySummaryRow,
  CoachingReportSummaryRow,
  CoachingScoreAnalytics,
} from "@/lib/coaching/types";

export const dynamic = "force-dynamic";

function filterQuarterlyByReports(
  quarterlySummary: CoachingQuarterlySummaryRow[],
  reports: CoachingReportSummaryRow[],
) {
  const visibleHrIds = new Set(reports.map((report) => normalizeHrId(report.medicalRepHrId)));
  return quarterlySummary.filter((row) => visibleHrIds.has(normalizeHrId(row.medicalRepHrId)));
}

export default async function TrainingManagerCoachingDashboardPage() {
  const access = await resolveAccessContextFromPage();
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

  const coachHrId = normalizeHrId(access.hrId);
  if (!coachHrId) {
    return (
      <EmployeePortalEmptyState
        message="This Training Manager account needs a linked HR_ID before coaching analytics can be loaded."
        title="Training Manager Profile Unlinked"
      />
    );
  }

  let reports: CoachingReportSummaryRow[] = [];
  let quarterlySummary: CoachingQuarterlySummaryRow[] = [];
  let scoreAnalytics: CoachingScoreAnalytics | null = null;
  try {
    reports = await getCoachingReports({ coachHrId }, access);
    const [allQuarterlySummary, resolvedScoreAnalytics] = await Promise.all([
      getCoachingQuarterlySummary({}, access),
      getCoachingScoreAnalyticsForReports(reports),
    ]);
    quarterlySummary = filterQuarterlyByReports(allQuarterlySummary, reports);
    scoreAnalytics = resolvedScoreAnalytics;
  } catch {
    return (
      <EmployeePortalEmptyState
        message="Unable to load Training Manager coaching analytics. Please try again later."
        title="Coaching Dashboard Unavailable"
      />
    );
  }
  if (!scoreAnalytics) {
    return (
      <EmployeePortalEmptyState
        message="Unable to prepare Training Manager coaching analytics. Please try again later."
        title="Coaching Dashboard Unavailable"
      />
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Training Manager"
      description="A coaching-first dashboard focused on field excellence, submitted reports, acknowledgment follow-up, and development trends."
      title="Coaching Analytics Dashboard"
    >
      <TrainingManagerCoachingDashboard
        quarterlySummary={quarterlySummary}
        reports={reports}
        scoreAnalytics={scoreAnalytics}
      />
    </EmployeePortalPageShell>
  );
}
