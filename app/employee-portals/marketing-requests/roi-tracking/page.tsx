import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRoiTrackingWorkspace } from "@/components/employee-portal/marketing-roi-tracking-workspace";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingRoiTrackingPage() {
  await assertEmployeePortalMarketingPageAccess("roi-tracking");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Realized sales of the promoted products in each request, at its pharmacies, within its ROI window, measured against the required return."
      title="ROI Tracking"
    >
      <MarketingRoiTrackingWorkspace />
    </EmployeePortalPageShell>
  );
}
