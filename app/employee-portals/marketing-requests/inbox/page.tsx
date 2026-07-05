import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestInbox } from "@/components/employee-portal/marketing-request-inbox";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingInboxPage() {
  await assertEmployeePortalMarketingPageAccess("inbox");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Marketing requests that are currently waiting for your approval decision. Approve, return, or reject each one."
      title="Marketing Requests Inbox"
    >
      <MarketingRequestInbox />
    </EmployeePortalPageShell>
  );
}
