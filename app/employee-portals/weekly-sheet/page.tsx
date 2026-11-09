import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { WeeklySheetView } from "@/components/crm/regional/weekly-sheet-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklySheet } from "@/lib/crm/weekly-sheet";
import { parseWeeklySheetShow } from "@/lib/crm/weekly-sheet-summary";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsRegionOrDistrictReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Weekly Sheet (owner, 2026-11-08 — Dr. Hany Saad's seventh need, the Regional Sales Manager account; a District
 * Manager over their own district since 2026-11-09): every
 * rep's PM and AM against the working-day targets for the field week, and the doctors of each speciality inside
 * every AM account, read from the visit comments. `readsRegionOrDistrictReports` gates the page and the loader.
 *
 * `week` is any day of the week wanted (none: the last full week); `show` narrows the reps the screen lists — both
 * read strictly. The filter never changes a figure: the tiles, the bars and the lists are the whole team's, and each
 * district heading is the whole district's (the premium pass, 9 Nov 2026).
 */
export default async function WeeklySheetPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsRegionOrDistrictReports(viewer)) redirect("/employee-portals");

  const params = await searchParams;
  const week = Array.isArray(params.week) ? params.week[0] : params.week;
  const sheet = await loadWeeklySheet(viewer, isIsoDay(week) ? week : null);
  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="Every rep's field week, Saturday to Wednesday: PM and AM against the working-day targets, the pharmacies, and the doctors of each speciality inside every AM account."
      title="Weekly Sheet"
    >
      <WeeklySheetView sheet={sheet} show={parseWeeklySheetShow(params.show)} />
    </EmployeePortalPageShell>
  );
}
