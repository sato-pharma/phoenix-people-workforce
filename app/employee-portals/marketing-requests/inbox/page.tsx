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
      description="Marketing requests waiting for your approval decision, plus a History tab holding every request already approved, rejected or returned — with the full decision trail."
      title="Marketing Requests Inbox"
    >
      <MarketingRequestInbox />
    </EmployeePortalPageShell>
  );
}
