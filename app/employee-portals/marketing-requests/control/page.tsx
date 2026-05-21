import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingControlWorkspace } from "@/components/employee-portal/marketing-control-workspace";

export const dynamic = "force-dynamic";

export default function EmployeePortalMarketingControlPage() {
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
