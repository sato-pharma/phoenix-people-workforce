import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { WeeklySheetView } from "@/components/crm/regional/weekly-sheet-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklySheet } from "@/lib/crm/weekly-sheet";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsRegionalTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Weekly Sheet (owner, 2026-11-08 — Dr. Hany Saad's seventh need, the Regional Sales Manager account only): every
 * rep's PM against 50 and AM against 10 for the field week, and the doctors of each speciality inside every AM
 * account, read from the visit comments. `readsRegionalTeamReports` gates the page and the loader.
 */
export default async function WeeklySheetPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsRegionalTeamReports(viewer)) redirect("/employee-portals");

  const { week } = await searchParams;
  const sheet = await loadWeeklySheet(viewer, isIsoDay(week) ? week : null);
  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Every rep's week, Saturday to Wednesday: PM against 50, AM against 10, and the doctors of each speciality inside every AM account."
      title="Weekly Sheet"
    >
      <WeeklySheetView sheet={sheet} />
    </EmployeePortalPageShell>
  );
}
