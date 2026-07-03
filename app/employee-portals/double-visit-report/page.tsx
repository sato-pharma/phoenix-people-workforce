import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DoubleVisitReportWorkspace } from "@/components/double-visit-report/double-visit-report-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess, normalizeHrId } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getDoubleVisitReportData } from "@/lib/double-visit-analytics/service";
import { DV_FOCUS_ROLES } from "@/lib/employee-portal/home-snapshot";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function dateParam(value: string | string[] | undefined) {
  const text = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function tabParam(value: string | string[] | undefined): "log" | "neverVisited" | "probation" {
  const text = typeof value === "string" ? value : "";
  return text === "neverVisited" || text === "probation" ? text : "log";
}

export default async function DoubleVisitReportPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!DV_FOCUS_ROLES.has(access.role) || !(await canAccess(access, "double_visit_analytics", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const params = await searchParams;
  const tab = tabParam(params.tab);

  let data: Awaited<ReturnType<typeof getDoubleVisitReportData>> | null = null;
  try {
    data = await getDoubleVisitReportData({
      access,
      dateFrom: dateParam(params.dateFrom),
      dateTo: dateParam(params.dateTo),
    });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/double-visit-report", module: "double-visit-report", role: access.role, hrId: access.hrId },
      error,
    );
    data = null;
  }

  return (
    <EmployeePortalPageShell
      badge="Sales Intelligence"
      description="Every double visit in your scope — filterable, sortable, and exportable — plus who's never been visited and who's on probation."
      errorBoundaryTitle="Double Visit Report unavailable"
      title="Double Visit Report"
    >
      {!data || !data.schemaReady ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          We couldn&apos;t load the Double Visit Report right now. This is usually temporary — please refresh in a moment.
        </div>
      ) : (
        <DoubleVisitReportWorkspace
          data={data}
          initialTab={tab}
          initialVisitorIsViewer={params.visitor === "me"}
          viewerHrId={normalizeHrId(access.hrId)}
        />
      )}
    </EmployeePortalPageShell>
  );
}
