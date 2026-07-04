import { redirect } from "next/navigation";

import { EmployeePortalEmptyState, EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DoubleVisitAnalyticsWorkspace } from "@/components/double-visit-analytics/double-visit-analytics-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess, normalizeHrId } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getDoubleVisitDashboardData } from "@/lib/double-visit-analytics/service";
import type { DoubleVisitDashboardData } from "@/lib/double-visit-analytics/types";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales Intelligence section is Product / Group Product Managers only. The dashboard
// scope (self + reporting chain, WIDENED to the manager's whole product line) is applied
// inside getDoubleVisitDashboardData via resolveDoubleVisitAccessScope. This portal view is
// always read-only — there is no import/publish step anymore (the module reads the live
// Visits Report mirror directly) — the workspace is rendered with embedded=true.
const DOUBLE_VISIT_PORTAL_ROLES = new Set(["Product Manager", "Group Product Manager", "Training Manager", "Marketing Manager"]);

function dateParam(value: string | string[] | undefined) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

export default async function PortalDoubleVisitAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (
    !DOUBLE_VISIT_PORTAL_ROLES.has(access.role) ||
    !(await canAccess(access, "double_visit_analytics", "read"))
  ) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  let dashboard: DoubleVisitDashboardData | null = null;
  try {
    dashboard = await getDoubleVisitDashboardData({
      access,
      dateFrom: dateParam(params.dateFrom),
      dateTo: dateParam(params.dateTo),
    });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/double-visit-analytics", module: "double-visit-analytics", role: access.role, hrId: access.hrId },
      error,
    );
    dashboard = null;
  }

  // The loader can fail (e.g. iReports360 unreachable, query timeout). Render a graceful empty
  // state instead of an unhandled server-component error, matching the other SI portal pages.
  if (!dashboard) {
    return (
      <EmployeePortalPageShell
        badge="Sales Intelligence"
        description="Double-visit coverage for you and the team reporting to you — visits, AM/PM split, and per-rep intensity."
        errorBoundaryTitle="Double-Visit Analytics unavailable"
        title="Double-Visit Analytics"
      >
        <EmployeePortalEmptyState
          message="We couldn't load double-visit analytics right now. This is usually temporary — please refresh in a moment."
          title="Double-Visit Analytics unavailable"
        />
      </EmployeePortalPageShell>
    );
  }

  // "Your double visits" = the DVs the viewer personally performed (managerHrId === viewer). PM/GPM
  // oversee DVs but rarely perform them, so this is often 0 while the team total above is higher.
  const viewerKey = normalizeHrId(access.hrId);
  const ownDoubleVisits = viewerKey
    ? dashboard.managerSummaries.find((summary) => normalizeHrId(summary.managerHrId) === viewerKey)?.totalDvs ?? 0
    : 0;

  return (
    <EmployeePortalPageShell
      badge="Sales Intelligence"
      description="Double-visit coverage for you and the team reporting to you — visits, AM/PM split, and per-rep intensity."
      errorBoundaryTitle="Double-Visit Analytics unavailable"
      title="Double-Visit Analytics"
    >
      <DoubleVisitAnalyticsWorkspace
        dashboard={dashboard}
        embedded
        ownDoubleVisits={ownDoubleVisits}
      />
    </EmployeePortalPageShell>
  );
}
