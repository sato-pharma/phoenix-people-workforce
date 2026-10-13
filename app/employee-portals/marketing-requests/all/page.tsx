import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingAllRequests } from "@/components/employee-portal/marketing-all-requests";
import { MarketingReportShareLinksPanel } from "@/components/marketing-requests/report-share-links-panel";
import { canAccess } from "@/lib/auth/permissions";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingAllRequestsPage() {
  const access = await assertEmployeePortalMarketingPageAccess("all");
  const canShare = await canAccess(access, "expenses", "export");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Every marketing request raised on the system, with the approval step each one is waiting on."
      title="All Marketing Requests"
    >
      <div className="space-y-4">
        {canShare ? <MarketingReportShareLinksPanel /> : null}
        <MarketingAllRequests />
      </div>
    </EmployeePortalPageShell>
  );
}
