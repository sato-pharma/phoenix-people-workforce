import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DistrictManagerPlansView } from "@/components/crm/regional/district-manager-plans-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { parseDistrictPlanShow } from "@/lib/phoenix-crm/server/district-plans-summary";
import { loadDistrictManagersPlans } from "@/lib/phoenix-crm/server/manager-plan-bookings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * District Managers' Plans (owner, 2026-11-08 — Dr. Hany Saad's fifth need, the Regional Sales Manager account
 * only): each district manager's sent week, half by half, with the rep's own day and a neutral Chain visit line
 * where another manager is with the same rep that day. `readsRegionalTeamReports` gates the page and the loader.
 *
 * `week` is any day of the week wanted; `show` narrows the district managers the screen lists — both read strictly
 * (anything else is the current week and every seat). The filter never changes a figure: the tiles, the bars, the
 * week at a glance and the lists are the whole team's (the premium pass, 9 Nov 2026).
 */
export default async function DistrictManagerPlansPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsRegionalTeamReports(viewer)) redirect("/employee-portals");

  const params = await searchParams;
  const week = Array.isArray(params.week) ? params.week[0] : params.week;
  const report = await loadDistrictManagersPlans(viewer, isIsoDay(week) ? week : viewer.visitDay);
  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Each district manager's sent week: the rep for each half-day, the customers ticked, the rep's own day, any chain visit, and who is with each rep."
      title="District Managers' Plans"
    >
      <DistrictManagerPlansView report={report} show={parseDistrictPlanShow(params.show)} />
    </EmployeePortalPageShell>
  );
}
