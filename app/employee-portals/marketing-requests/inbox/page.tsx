import {
  EmployeePortalPageShell,
} from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestInbox } from "@/components/employee-portal/marketing-request-inbox";
import { MarketingWatchedRequestsSection } from "@/components/marketing-requests/marketing-watched-requests-section";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingInboxPage() {
  const access = await assertEmployeePortalMarketingPageAccess("inbox");

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Marketing requests waiting for your approval decision, plus a History tab holding every request already approved, rejected or returned — with the full decision trail."
      title="Marketing Requests Inbox"
    >
      <div className="space-y-6">
        {/* A product watcher sees every request for the products he follows first (owner, 2026-11-19). */}
        <MarketingWatchedRequestsSection access={access} />
        <MarketingRequestInbox />
      </div>
    </EmployeePortalPageShell>
  );
}
