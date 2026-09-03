import { MarketingAllRequests } from "@/components/employee-portal/marketing-all-requests";

import { assertMarketingAdminPageAccess } from "../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

/**
 * Admin-shell twin of the portal register. Same component, same data — Marketing Manager and SFE
 * Manager reach it through the portal, Super Admin through the admin sidebar, exactly like the
 * Approval Inbox above it.
 */
export default async function AdminMarketingAllRequestsPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>All Marketing Requests</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every marketing request raised on the system, with the approval step each one is waiting on.
          </p>
        </div>
      </div>
      <MarketingAllRequests />
    </div>
  );
}
