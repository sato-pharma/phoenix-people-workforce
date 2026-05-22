import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingControlWorkspace } from "@/components/employee-portal/marketing-control-workspace";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingControlPage() {
  await assertEmployeePortalMarketingPageAccess("control");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="SFE and admin controls for request types, workflow routing, ROI, finance, and validation governance."
      title="Marketing Control"
    >
      <MarketingControlWorkspace />
    </EmployeePortalPageShell>
  );
}
