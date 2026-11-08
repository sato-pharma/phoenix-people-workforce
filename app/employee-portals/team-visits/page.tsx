import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { TeamVisitsView } from "@/components/crm/regional/team-visits-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadTeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Visits — Yesterday and Today (owner, 2026-11-08 — Dr. Hany Saad's second need, the Regional Sales Manager
 * account only). `readsRegionalTeamReports` is the gate on this page and again inside the loader.
 */
export default async function TeamVisitsPage() {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsRegionalTeamReports(viewer)) redirect("/employee-portals");

  const report = await loadTeamVisitsReport(viewer);
  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Every rep under your district managers: yesterday's and today's visits, AM · PM · Pharmacies, and the time each visit was saved."
      title="Visits — Yesterday and Today"
    >
      <TeamVisitsView report={report} />
    </EmployeePortalPageShell>
  );
}
