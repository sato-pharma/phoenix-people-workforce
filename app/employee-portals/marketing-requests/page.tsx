import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";
import { MarketingWatchedRequestsSection } from "@/components/marketing-requests/marketing-watched-requests-section";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingRequestsPage() {
  const access = await assertEmployeePortalMarketingPageAccess("requests");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Create draft activities, forecast product ROI, and keep request rows ready for validation."
      title="Marketing Requests"
    >
      <div className="space-y-6">
        {/* A product watcher sees every request for the products he follows first (owner, 2026-11-19). */}
        <MarketingWatchedRequestsSection access={access} />
        <MarketingRequestDraftWorkspace />
      </div>
    </EmployeePortalPageShell>
  );
}
