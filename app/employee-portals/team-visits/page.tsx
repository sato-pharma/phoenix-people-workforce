import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { TeamVisitsView } from "@/components/crm/regional/team-visits-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadTeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";
import { parseTeamVisitDay, parseTeamVisitShow, parseTeamVisitSort } from "@/lib/phoenix-crm/server/team-visits-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Visits — Yesterday and Today (owner, 2026-11-08 — Dr. Hany Saad's second need, the Regional Sales Manager
 * account only). `readsRegionalTeamReports` is the gate on this page and again inside the loader.
 *
 * `show` and `day` narrow the reps the screen lists, and `sort` orders them inside each team — all three read
 * strictly (anything else is every rep, judged by yesterday, in territory order). They never change a figure: the
 * tiles, the teams and the district managers' totals are the whole team's.
 */
export default async function TeamVisitsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsRegionalTeamReports(viewer)) redirect("/employee-portals");

  const params = await searchParams;
  const report = await loadTeamVisitsReport(viewer);
  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Every rep under your district managers: yesterday's and today's visits, AM · PM · Pharmacies, and the time each visit was saved."
      title="Visits — Yesterday and Today"
    >
      <TeamVisitsView day={parseTeamVisitDay(params.day)} nowIso={new Date().toISOString()} report={report} show={parseTeamVisitShow(params.show)} sort={parseTeamVisitSort(params.sort)} />
    </EmployeePortalPageShell>
  );
}
