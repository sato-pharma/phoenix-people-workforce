import {
  EmployeePortalEmptyState,
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingRequestsPage() {
  try {
    await assertEmployeePortalMarketingPageAccess("requests");
  } catch (error) {
    if (typeof (error as { digest?: string }).digest === "string") throw error;
    console.error("[employee-portal] marketing-requests access check failed:", error);
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
      description="Create draft activities, forecast product ROI, and keep request rows ready for validation."
      title="Marketing Requests"
    >
      <MarketingRequestDraftWorkspace />
    </EmployeePortalPageShell>
  );
}
