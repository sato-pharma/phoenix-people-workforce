import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingControlWorkspace } from "@/components/employee-portal/marketing-control-workspace";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingControlPage() {
  try {
    await assertEmployeePortalMarketingPageAccess("control");
  } catch (error) {
    if (typeof (error as { digest?: string }).digest === "string") throw error;
    console.error("[employee-portal] marketing-control access check failed:", error);
    return (
      <EmployeePortalEmptyState
        message="Unable to verify your access. Please try again or contact your administrator."
        title="Access Check Failed"
      />
    );
  }

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
