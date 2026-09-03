import { MarketingRequestInbox } from "@/components/employee-portal/marketing-request-inbox";

import { assertMarketingAdminPageAccess } from "../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function AdminMarketingInboxPage() {
  await assertMarketingAdminPageAccess({ approvalInbox: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Approval Inbox</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every marketing request that involves you, one queue at a time — waiting on your decision, coming to you
            later in the chain, or open for your comment — with what it costs and how long it has been sitting shown
            before you read a word of it. The History tab holds every request already approved, rejected or returned,
            with the full decision trail.
          </p>
        </div>
      </div>
      {/* MarketingRequestInbox defaults decisionBasePath to the PORTAL. This page is the admin
          shell and its principal user is the SFE Manager, an admin-shell role — without this prop
          an SFE clicking "Validate & Forward" was thrown out to /employee-portals mid-decision. */}
      <MarketingRequestInbox decisionBasePath="/workspace/marketing-requests/decision" />
    </div>
  );
}
