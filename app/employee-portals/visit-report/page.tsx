import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { VisitReportGenerator, type VisitReportInitial } from "@/components/phoenix-crm/visit-report/visit-report-generator";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReadVisitReport, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadVisitReportScope } from "@/lib/phoenix-crm/server/visit-report";
import { visitReportFieldsFor } from "@/lib/phoenix-crm/visit-report-fields";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Visit report generator — the DISTRICT MANAGER's own copy, his team and nobody else's (owner,
 * 2026-10-15: "start building same module for DSMs only their scope").
 *
 * It is the Super Admin's page (`/admin/phoenix-crm/visit-report`) drawn in the portal shell, because a
 * district manager's navigation mode is `employee-portal` and an admin-shell address would bounce him
 * (the Place checks page is built the same way, for the same reason). The picker, the dashboard, the map,
 * the visits and the workbook are the same component and the same loader; what differs is who is asked:
 * `loadVisitReportScope` and `loadVisitReport` choose seats from the viewer's own scope, so a rep, or a
 * district, that is not his is neither offered nor answered — a 404 with the same sentence as one that
 * does not exist.
 *
 * 🔴 A PAGE OF ITS OWN, NEVER A TAB OF THE PHOENIX CRM APP. The module's tabs are the component tree a rep
 * runs; the report shows where named people's phones were, so one wrong role check inside that tree
 * would show a rep that anything was measured (Golden Rule #1). Here `canReadVisitReport` decides, and
 * anybody else is redirected rather than told the page exists.
 */
export default async function TeamVisitReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/employee-portals");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadVisitReport(viewer)) redirect("/employee-portals");

  const scope = await loadVisitReportScope(viewer);

  const params = await searchParams;
  const first = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));
  const initial: VisitReportInitial = {
    apply: first(params.apply) === "1",
    fields: first(params.fields).split(",").map((key) => key.trim()).filter(Boolean),
    from: first(params.from),
    target: first(params.target),
    to: first(params.to),
  };

  return (
    <EmployeePortalPageShell
      badge="CRM"
      description={`Choose one of your reps, or your whole district, and a period, then the fields you want from the ${visitReportFieldsFor(scope.sight).length} you can choose. The dashboard, the map, the visits and the Excel file are all built from exactly that choice.`}
      title="Visit report"
    >
      <CrmSurfaceProvider surface="portal">
        <VisitReportGenerator initial={initial} scope={scope} />
      </CrmSurfaceProvider>
    </EmployeePortalPageShell>
  );
}
