import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRoiFilterEngine } from "@/components/marketing-requests/roi-filter-engine";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingRoiTrackingPage() {
  await assertEmployeePortalMarketingPageAccess("roi-tracking");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Filter your marketing requests, then measure realized sales of the promoted products against the required return."
      title="ROI Tracking"
    >
      <MarketingRoiFilterEngine viewSalesBasePath="/employee-portals" />
    </EmployeePortalPageShell>
  );
}
