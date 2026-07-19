import { redirect } from "next/navigation";
import { BarChart3 } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { DirectOrderReportWorkspace } from "@/components/direct-orders/direct-order-report-workspace";
import { getDirectOrderReport, resolveDirectOrderReportScope } from "@/lib/direct-orders/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminDirectOrdersReportPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/direct-orders/report");
  const rows = await getDirectOrderReport(access);
  const scope = resolveDirectOrderReportScope(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Sales"
        title="Direct Orders Report"
        description="Every direct order — requests, approvals, pharmacies, and money — filter, sort, and export."
        icon={<BarChart3 className="h-3.5 w-3.5" />}
      />
      <DirectOrderReportWorkspace rows={rows} scope={scope} />
    </div>
  );
}
