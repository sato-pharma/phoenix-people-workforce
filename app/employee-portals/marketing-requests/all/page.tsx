import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingAllRequests } from "@/components/employee-portal/marketing-all-requests";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingAllRequestsPage() {
  await assertEmployeePortalMarketingPageAccess("all");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Every marketing request raised on the system, with the approval step each one is waiting on."
      title="All Marketing Requests"
    >
      <MarketingAllRequests />
    </EmployeePortalPageShell>
  );
}
