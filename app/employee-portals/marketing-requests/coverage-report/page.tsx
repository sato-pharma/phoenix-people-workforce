import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingCoverageReportWorkspace } from "@/components/marketing-requests/marketing-coverage-report-workspace";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingCoverageReportPage() {
  const access = await assertEmployeePortalMarketingPageAccess("coverage-report");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Filter by line, region, area, hierarchy tier or a named person, see premium KPI totals, then expand any request to its target pharmacies — every pharmacy shows its realized sales, even when zero."
      title="Marketing Coverage Report"
    >
      <MarketingCoverageReportWorkspace isSuperAdmin={access.role === "Super Admin"} />
    </EmployeePortalPageShell>
  );
}
