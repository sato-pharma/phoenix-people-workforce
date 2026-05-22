import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingRequestsPage() {
  await assertEmployeePortalMarketingPageAccess("requests");

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
