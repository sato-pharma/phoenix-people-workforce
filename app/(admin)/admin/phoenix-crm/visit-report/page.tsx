import { redirect } from "next/navigation";
import { ClipboardList } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { VisitReportGenerator, type VisitReportInitial } from "@/components/phoenix-crm/visit-report/visit-report-generator";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canReadVisitReport, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadVisitReportScope } from "@/lib/phoenix-crm/server/visit-report";
import { visitReportFieldsFor } from "@/lib/phoenix-crm/visit-report-fields";

export const dynamic = "force-dynamic";

/**
 * The Visit report generator — pick a rep or a district and a period, choose which of the visit's fields
 * to report, and read a dashboard, a map and every visit, or download the same choice as one workbook tab
 * (owner, 2026-10-15).
 *
 * 🔴 THE SUPER ADMIN'S AND THE SFE MANAGER'S, AND THE DISTRICT MANAGER'S FOR HIS OWN TEAM (his copy is
 * `/employee-portals/visit-report`) — `canReadVisitReport`, on this page and again inside the
 * loader. It shows where named people's phones were, so it is the integrity board's shape: a page of its
 * own under /admin, which a rep cannot open, never a tab in the component tree the field app renders —
 * one wrong role check there would show a rep that he had been looked at (Golden Rule #1). Anybody else
 * is redirected rather than told the page exists. The SFE Manager is offered every field except the
 * mock-location evidence; the loader never reads it for him.
 */
export default async function PhoenixCrmVisitReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!(await canAccess(access, "phoenix_crm", "read"))) redirect("/admin");
  const viewer = await resolvePhoenixCrmViewer(access).catch(() => null);
  if (!viewer || !canReadVisitReport(viewer)) redirect("/admin");

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
    <div className="space-y-5">
      <AdminPageHero
        description={`Choose a rep or a district and a period, then the fields you want from the ${visitReportFieldsFor(scope.sight).length} you can choose. The dashboard, the map, the visits and the Excel file are all built from exactly that choice. The rep is never shown that this exists.`}
        eyebrow="CRM"
        icon={<ClipboardList className="h-3.5 w-3.5" />}
        title="Visit report"
      />
      <CrmSurfaceProvider surface="admin">
        <VisitReportGenerator initial={initial} scope={scope} />
      </CrmSurfaceProvider>
    </div>
  );
}
