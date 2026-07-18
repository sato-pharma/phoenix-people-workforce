import { redirect } from "next/navigation";

import { DvPlannerWorkspace } from "@/components/employee-portal/dv-planner-workspace";
import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { canAccess, normalizeHrId } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { addDaysIso, todayIso } from "@/lib/crm/dates";
import { buildDvPlannerRoster } from "@/lib/double-visit-analytics/planner";
import { getDoubleVisitReportData } from "@/lib/double-visit-analytics/service";
import { DV_FOCUS_ROLES } from "@/lib/employee-portal/home-snapshot";
import { logPortalFailure } from "@/lib/observability/portal-logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function DvPlannerPage() {
  const access = await resolveAccessContextFromPage();
  if (!access.loginId && !access.hrId) redirect("/login");
  if (!DV_FOCUS_ROLES.has(access.role) || !(await canAccess(access, "double_visit_analytics", "read"))) {
    redirect(resolveLandingPathForRole(access.role));
  }

  const today = todayIso();
  const dateFrom = addDaysIso(today, -45);
  const dateTo = addDaysIso(today, 7);

  let data: Awaited<ReturnType<typeof getDoubleVisitReportData>> | null = null;
  try {
    data = await getDoubleVisitReportData({ access, dateFrom, dateTo });
  } catch (error) {
    logPortalFailure(
      { route: "/employee-portals/dv-planner", module: "dv-planner", role: access.role, hrId: access.hrId },
      error,
    );
  }

  const { reps, visits } = buildDvPlannerRoster(data);

  return (
    <EmployeePortalPageShell
      badge="Fieldforce"
      description="Choose a Medical Rep and a date. Phoenix checks the CRM mirror and answers whether a double visit was recorded on that exact day."
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
          reps={reps}
          today={today}
          viewerHrId={normalizeHrId(access.hrId) ?? access.loginId ?? "local"}
          visits={visits}
        />
      )}
    </EmployeePortalPageShell>
  );
}
