import { redirect } from "next/navigation";
import { UsersRound } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DoubleVisitReportView } from "@/components/phoenix-crm/double-visit-requests";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { doubleVisitReportAudience, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const dynamic = "force-dynamic";

/**
 * Double visit requests — the Super Admin's, the CEO's and the SFE Manager's copy of the managers' report
 * (owner, 2026-10-16: "all managers must have access on this report as per their scope upto ceo"). Every
 * other manager reads his own team's at `/employee-portals/double-visit-requests`, because his navigation
 * mode is the employee portal and an admin-shell address would bounce him.
 *
 * It is the same component and the same loader; what differs is who is asked. `doubleVisitReportAudience`
 * decides on this page and again inside every route, and anybody it refuses is redirected rather than
 * told the page exists. The Super Admin reads every territory and answers nothing real — a request is
 * answered by the person it was addressed to.
 */
export default async function PhoenixCrmDoubleVisitRequestsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || doubleVisitReportAudience(viewer) === null) redirect("/admin");

  return (
    <div className="space-y-5">
      <AdminPageHero
        description="The double visits the reps ask their managers and product managers for at a customer, the days they offer, and how every person asked has answered."
        eyebrow="CRM"
        icon={<UsersRound className="h-3.5 w-3.5" />}
        title="Double visit requests"
      />
      <CrmSurfaceProvider surface="admin">
        <DoubleVisitReportView cairoToday={viewer.cairoToday} test={viewer.isTestPersona} />
      </CrmSurfaceProvider>
    </div>
  );
}
