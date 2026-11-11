import { redirect } from "next/navigation";
import { FileSpreadsheet } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { WeeklySheetView } from "@/components/crm/regional/weekly-sheet-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { loadWeeklySheet } from "@/lib/crm/weekly-sheet";
import { parseWeeklySheetShow } from "@/lib/crm/weekly-sheet-summary";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsCompanyTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Weekly Sheet, the Super Admin's twin over the whole company (owner, 2026-11-11: "add for the admin the reports u
 * added to hany saad in his overview dashboard"): every rep's PM and AM against the working-day targets for the field
 * week, and the doctors of each speciality inside every AM account — the screen Dr. Hany Saad reads over his region.
 *
 * 🔴 `readsCompanyTeamReports` — the Super Admin alone — on this page, and `readsAnyTeamReport` again in the loader.
 */
export default async function AdminWeeklySheetPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsCompanyTeamReports(viewer)) redirect("/admin");

  const params = await searchParams;
  const week = Array.isArray(params.week) ? params.week[0] : params.week;
  const sheet = await loadWeeklySheet(viewer, isIsoDay(week) ? week : null);
  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every rep's field week across the company, Saturday to Wednesday: PM and AM against the working-day targets, the pharmacies, and the doctors of each speciality inside every AM account."
        eyebrow="CRM"
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
        title="Weekly Sheet"
      />
      <WeeklySheetView sheet={sheet} show={parseWeeklySheetShow(params.show)} surface="admin" />
    </div>
  );
}
