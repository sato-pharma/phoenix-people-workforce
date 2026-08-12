import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderReportWorkspace } from "@/components/direct-orders/direct-order-report-workspace";
import { getDirectOrderReport, resolveDirectOrderReportScope } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertDirectOrdersPageAccess } from "@/lib/direct-orders/page-access";

export const dynamic = "force-dynamic";

export default async function PortalDirectOrdersReportPage() {
  const access = await resolveAccessContextFromPage();
  await assertDirectOrdersPageAccess(access);
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/direct-orders/report");
  const rows = await getDirectOrderReport(access);
  const scope = resolveDirectOrderReportScope(access);
  return (
    <EmployeePortalPageShell
      badge="Sales"
      title="Direct Orders Report"
      description="Every direct order — requests, approvals, pharmacies, and money — filter, sort, and export."
    >
      <DirectOrderReportWorkspace rows={rows} scope={scope} detailBasePath="/employee-portals/direct-orders" />
    </EmployeePortalPageShell>
  );
}
