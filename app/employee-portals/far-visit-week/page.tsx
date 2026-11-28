import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { FarVisitWeekReportView } from "@/components/phoenix-crm/far-visit-week-report-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { FAR_VISIT_WEEK_PATHS } from "@/lib/phoenix-crm/far-visit-week-rules";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadFarVisitWeekPage } from "@/lib/phoenix-crm/server/far-visit-week-page";
import { canReadFarVisitWeekReport } from "@/lib/phoenix-crm/server/far-visit-week-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Far-visit week, a MANAGER's own copy (a District Manager, acting or not, or the National Sales Manager): his scope and nobody else's (owner, 28 Nov 2026: "in the managers'
 * accounts, each within his own scope"). The Super Admin's page (`/admin/phoenix-crm/far-visit-week`) drawn in the
 * portal shell, because a manager's navigation mode is `employee-portal`; the loader picks the territories from the
 * viewer's own scope and never his own seat as a rep.
 *
 * 🔴 A PAGE OF ITS OWN, NEVER A TAB OF THE PHOENIX CRM APP (Golden Rule #1): `canReadFarVisitWeekReport` decides,
 * and anybody else is redirected rather than told the page exists.
 */
export default async function TeamFarVisitWeekPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadFarVisitWeekReport(viewer)) redirect("/employee-portals");

  const { report, selected } = await loadFarVisitWeekPage(viewer, await searchParams);

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Each of your reps' week, a day at a time: clean, rejected for where the visit was logged, or waiting for the SFE. Open a red day to see each visit and the map behind it; the Excel file holds the same week."
      title="Far-visit week"
    >
      <FarVisitWeekReportView basePath={FAR_VISIT_WEEK_PATHS.portal} report={report} selected={selected} />
    </EmployeePortalPageShell>
  );
}
