import { redirect } from "next/navigation";

import { DvPlannerWorkspace } from "@/components/employee-portal/dv-planner-workspace";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess, normalizeHrId } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
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

export default async function DvPlannerPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!DV_FOCUS_ROLES.has(access.role) || !(await canAccess(access, "double_visit_analytics", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const today = todayIso();
  const params = await searchParams;
  const dateFrom = dateParam(params.dateFrom) ?? addDaysIso(today, -30);
  const dateTo = dateParam(params.dateTo) ?? today;

  let data: Awaited<ReturnType<typeof getDoubleVisitReportData>> | null = null;
  try {
    data = await getDoubleVisitReportData({ access, dateFrom, dateTo, includeCadence: true });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/dv-planner", module: "dv-planner", role: access.role, hrId: access.hrId },
      error,
    );
  }

  return (
    <EmployeePortalPageShell
      badge="Fieldforce"
      description="Every Medical Rep in your scope for the chosen period — who's covered, who's never been visited, and who's on probation."
      errorBoundaryTitle="DV Planner unavailable"
      title="DV Planner"
    >
      {!data || !data.schemaReady ? (
        <div className="border border-slate-200 bg-white px-5 py-8 text-center text-sm text-slate-500">
          CRM double-visit data is unavailable right now. Refresh after the next CRM sync.
        </div>
      ) : (
        <DvPlannerWorkspace
          dateFrom={dateFrom}
          dateTo={dateTo}
          roster={data.roster}
          rows={data.rows}
          startingSoon={data.startingSoon}
          viewerHrId={normalizeHrId(access.hrId) ?? access.loginId ?? "local"}
        />
      )}
    </EmployeePortalPageShell>
  );
}
