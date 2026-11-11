import { redirect } from "next/navigation";
import { Users } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DistrictManagerPlansView } from "@/components/crm/regional/district-manager-plans-view";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isIsoDay } from "@/lib/phoenix-crm/calendar";
import { readsCompanyTeamReports, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { parseDistrictPlanShow } from "@/lib/phoenix-crm/server/district-plans-summary";
import { loadDistrictManagersPlans } from "@/lib/phoenix-crm/server/manager-plan-bookings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * District Managers' Plans, the Super Admin's twin over the whole company (owner, 2026-11-11: "add for the admin the
 * reports u added to hany saad in his overview dashboard"): every district manager's sent week, half by half, with
 * the rep's own day and a neutral Chain visit line — the screen Dr. Hany Saad reads over his region.
 *
 * 🔴 `readsCompanyTeamReports` — the Super Admin alone — on this page, and `readsAnyTeamReport` again in the loader.
 */
export default async function AdminDistrictManagerPlansPage({ searchParams }: PageProps) {
  const access = await resolveAccessContextFromPage();
  if (access.source === "guest") redirect("/login");
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !readsCompanyTeamReports(viewer)) redirect("/admin");

  const params = await searchParams;
  const week = Array.isArray(params.week) ? params.week[0] : params.week;
  const report = await loadDistrictManagersPlans(viewer, isIsoDay(week) ? week : viewer.visitDay);
  return (
    <div className="space-y-5">
      <AdminPageHero
        description="Every district manager's sent week, across the company: the rep for each half-day, the customers ticked, the rep's own day, any chain visit, and who is with each rep."
        eyebrow="CRM"
        icon={<Users className="h-3.5 w-3.5" />}
        title="District Managers' Plans"
      />
      <DistrictManagerPlansView report={report} show={parseDistrictPlanShow(params.show)} surface="admin" />
    </div>
  );
}
