import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { EmployeeCoachingList } from "@/components/coaching/employee-coaching-list";
import {
  EmployeePortalActionBar,
  EmployeePortalActionLink,
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { resolveEmployeeCoachingPortalMode } from "@/lib/coaching/portal-access";
import { getMyCoachingReports, getTeamCoachingReports } from "@/lib/coaching/service";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const dynamic = "force-dynamic";

// No `title` here on purpose: the portal layout names every tab after the viewer's own nav
// row for the page (see src/lib/navigation/module-title.ts), which is "My Coaching Reports"
// for a rep and "Team Coaching Reports" for their manager. A fixed title here would win the
// first paint and then be renamed by DocumentTitleSync a moment later — a visible flicker,
// and the wrong wording for one of the two audiences.
export const metadata: Metadata = {
  description:
    "View and track field coaching reports, performance scores, zone distribution, and acknowledgment status for the medical team.",
};

export default async function EmployeeCoachingReportsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/coaching/new");
  }

  if (!(await canAccess(access, "coaching", "read"))) {
    return (
      <EmployeePortalEmptyState
        message="Your account is not authorized to view coaching reports."
        title="Coaching Access Unavailable"
      />
    );
  }

  const coachingMode = await resolveEmployeeCoachingPortalMode(access);
  if (!coachingMode) {
    return (
      <EmployeePortalEmptyState
        message="Coaching reports are available to Medical Reps for their own reports, and to DSM/RM/NSM roles for team reports."
        title="Coaching Access Unavailable"
      />
    );
  }
  const isMyReportsView = coachingMode === "self";

  let reports = null;
  try {
    reports = isMyReportsView
      ? await getMyCoachingReports(access)
      : await getTeamCoachingReports(access);
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/coaching", module: "coaching", role: access.role, hrId: access.hrId },
      error,
    );
    reports = null;
  }

  if (!reports) {
    return (
      <EmployeePortalEmptyState
        message="Unable to load your coaching reports. Please try again later."
        title="Coaching Reports Unavailable"
      />
    );
  }

  const title = isMyReportsView ? "My Coaching Reports" : "Team Coaching Reports";
  const description = isMyReportsView
    ? "Review your submitted field coaching reports, scores, feedback, and acknowledgment status."
    : "Review submitted field coaching reports, scores, and acknowledgment status for the Medical Reps in your scope.";

  return (
    <EmployeePortalPageShell
      badge="Field Excellence"
      description={description}
      title={title}
    >
      <EmployeePortalActionBar
        actions={
          <>
            <span className="rounded border border-orange-200 bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-700">
              {reports.length} report{reports.length === 1 ? "" : "s"}
            </span>
            <EmployeePortalActionLink href="/employee-portals" label="Back to Dashboard" />
          </>
        }
      />
      <EmployeeCoachingList mode={isMyReportsView ? "self" : "team"} reports={reports} />
    </EmployeePortalPageShell>
  );
}
