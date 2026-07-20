import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { DirectOrderPortalReport } from "@/components/employee-portal/direct-order-portal-report";
import { getDirectOrderReport, resolveDirectOrderReportScope } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function PortalDirectOrdersReportPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) !== "employee-portal") redirect("/admin/direct-orders/report");
  const rows = await getDirectOrderReport(access);
  const scope = resolveDirectOrderReportScope(access);
  return (
    <EmployeePortalPageShell
      badge="Sales"
      title="Direct Orders Report"
      description="Every direct order — requests, approvals, pharmacies, and money — filter, sort, and export."
    >
      <DirectOrderPortalReport rows={rows} scope={scope} />
    </EmployeePortalPageShell>
  );
}
