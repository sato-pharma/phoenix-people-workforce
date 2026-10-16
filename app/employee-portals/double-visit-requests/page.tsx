import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DoubleVisitReportView } from "@/components/phoenix-crm/double-visit-requests";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { doubleVisitReportAudience, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Double visit requests — the managers' report of the double visits reps ask for (owner, 2026-10-16: "a
 * new sidebar report is generated for managers which pumps notifications when he receives this request
 * and all managers must have access on this report as per their scope upto ceo").
 *
 * Every manager who holds a seat reads the requests of the territories beneath him, the product managers
 * and the Marketing Manager read the requests addressed to them, and each person asked accepts one of the
 * rep's days or declines right here. The Super Admin, the CEO and the SFE Manager read the same report on
 * the admin shell at `/admin/phoenix-crm/double-visit-requests`.
 *
 * 🔴 `doubleVisitReportAudience` IS THE GATE, ON THIS PAGE AND AGAIN IN EVERY ROUTE AND THE LOADER — the
 * sidebar row asks the very same function, so it cannot open onto a redirect. A rep is redirected rather
 * than told the page exists: he reads his own requests, and every answer, on his customer's page.
 */
export default async function DoubleVisitRequestsPage() {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || doubleVisitReportAudience(viewer) === null) redirect("/employee-portals");

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description="The double visits your reps ask for at a customer, the days they offer and every person's answer. A request addressed to you waits at the top: accept one of the rep's days, or decline."
      title="Double visit requests"
    >
      <CrmSurfaceProvider surface="portal">
        <DoubleVisitReportView cairoToday={viewer.cairoToday} test={viewer.isTestPersona} />
      </CrmSurfaceProvider>
    </EmployeePortalPageShell>
  );
}
