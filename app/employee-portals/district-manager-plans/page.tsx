import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DistrictManagerPlansView } from "@/components/crm/regional/district-manager-plans-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDistrictManagersPlans } from "@/lib/phoenix-crm/server/manager-plan-bookings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * District Managers' Plans (owner, 2026-11-08 — Dr. Hany Saad's fifth need, the Regional Sales Manager account
 * only): each district manager's sent week, half by half, with the rep's own day and a neutral Chain visit line
 * where another manager is with the same rep that day. `readsRegionalTeamReports` gates the page and the loader.
 */
export default async function DistrictManagerPlansPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsRegionalTeamReports(viewer)) redirect("/employee-portals");

  const { week } = await searchParams;
  const report = await loadDistrictManagersPlans(viewer, isIsoDay(week) ? week : viewer.visitDay);
  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Each district manager's sent week: the rep for each half-day, the customers ticked, the rep's own day, and any chain visit."
      title="District Managers' Plans"
    >
      <DistrictManagerPlansView report={report} />
    </EmployeePortalPageShell>
  );
}
