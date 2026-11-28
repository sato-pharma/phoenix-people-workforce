import { redirect } from "next/navigation";
import { CalendarRange } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { FarVisitWeekReportView } from "@/components/phoenix-crm/far-visit-week-report-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { FAR_VISIT_WEEK_PATHS } from "@/lib/phoenix-crm/far-visit-week-rules";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadFarVisitWeekPage } from "@/lib/phoenix-crm/server/far-visit-week-page";
import { canReadFarVisitWeekReport } from "@/lib/phoenix-crm/server/far-visit-week-report";

export const dynamic = "force-dynamic";

/**
 * The Far-visit week (owner, 28 Nov 2026): every rep, his week day by day (green "Clean", red "N rejected", amber
 * "N waiting"), and a day that is not clean opens with every refused or held visit of it and the map behind each.
 * The same week downloads as Excel.
 *
 * 🔴 A PAGE OF ITS OWN, NEVER A TAB OF THE PHOENIX CRM APP. It is location evidence about named people, so the
 * team reports' readers only (`canReadFarVisitWeekReport`, here and again inside the loader); anybody else is
 * redirected rather than told the page exists (Golden Rule #1). The managers' copy is
 * `/employee-portals/far-visit-week`.
 */
export default async function PhoenixCrmFarVisitWeekPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadFarVisitWeekReport(viewer)) redirect("/admin");

  const { report, selected } = await loadFarVisitWeekPage(viewer, await searchParams);

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every rep's week, a day at a time: clean, rejected for where the visit was logged, or waiting for the SFE. Open a red day to see each visit and the map behind it; the Excel file holds the same week."
        eyebrow="CRM"
        icon={<CalendarRange className="h-3.5 w-3.5" />}
        title="Far-visit week"
      />
      <FarVisitWeekReportView basePath={FAR_VISIT_WEEK_PATHS.admin} report={report} selected={selected} />
    </div>
  );
}
