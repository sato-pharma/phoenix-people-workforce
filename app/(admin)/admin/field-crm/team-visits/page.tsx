import { redirect } from "next/navigation";
import { Clock } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { TeamVisitsView } from "@/components/crm/regional/team-visits-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { readsCompanyTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadTeamVisitsReport } from "@/lib/phoenix-crm/server/team-visits";
import { parseTeamVisitDay, parseTeamVisitShow, parseTeamVisitSort } from "@/lib/phoenix-crm/server/team-visits-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Visits — Yesterday and Today, the Super Admin's twin over the whole company (owner, 2026-11-11: "add for the admin
 * the reports u added to hany saad in his overview dashboard"). The same screen Dr. Hany Saad reads over his region
 * (`app/employee-portals/team-visits`), every rep grouped by region and district manager.
 *
 * 🔴 `readsCompanyTeamReports` — the Super Admin alone — on this page, and `readsAnyTeamReport` again in the loader.
 */
export default async function AdminTeamVisitsPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsCompanyTeamReports(viewer)) redirect("/admin");

  const params = await searchParams;
  const report = await loadTeamVisitsReport(viewer);
  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every rep in the company, by region and district manager: yesterday's and today's visits, AM · PM · Pharmacies, and the time each visit was saved."
        eyebrow="CRM"
        icon={<Clock className="h-3.5 w-3.5" />}
        title="Visits — Yesterday and Today"
      />
      <TeamVisitsView
        day={parseTeamVisitDay(params.day)}
        nowIso={new Date().toISOString()}
        report={report}
        show={parseTeamVisitShow(params.show)}
        sort={parseTeamVisitSort(params.sort)}
        surface="admin"
      />
    </div>
  );
}
