import { redirect } from "next/navigation";
import { BarChart3 } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderReportWorkspace } from "@/components/direct-orders/direct-order-report-workspace";
import { ReportShareLinksPanel } from "@/components/direct-orders/report-share-links-panel";
import { systemDeployment } from "@/config/system-settings";
import { getDirectOrderReport, resolveDirectOrderReportScope } from "@/lib/direct-orders/service";
import { canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminDirectOrdersReportPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `?unbooked=1` opens the report already narrowed to approved orders with no sales month. Read
  // here rather than with useSearchParams inside the workspace, which would put the whole table
  // behind a Suspense boundary for one boolean. Both of the Finance Manager's routes into this
  // page carry it — the sidebar badge and his command center's queue row.
  const params = (await searchParams) ?? {};
  const unbookedParam = params.unbooked;
  const initialUnbookedOnly = (Array.isArray(unbookedParam) ? unbookedParam[0] : unbookedParam) === "1";

  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/direct-orders/report");
  const rows = await getDirectOrderReport(access);
  const scope = resolveDirectOrderReportScope(access);
  // Publishing the report outside the login wall is the EXPORT permission's strongest form, so it
  // is gated on exactly that — a reader who may not export must not be able to publish instead.
  const canShare = await canAccess(access, "direct_orders", "export");
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders Report"
        description="Every direct order — requests, approvals, pharmacies, and money — filter, sort, and export."
        icon={<BarChart3 className="h-3.5 w-3.5" />}
      />
      {canShare ? <ReportShareLinksPanel productionUrl={systemDeployment.productionUrl} /> : null}
      <DirectOrderReportWorkspace initialUnbookedOnly={initialUnbookedOnly} rows={rows} scope={scope} />
    </div>
  );
}
