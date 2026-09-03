import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";

import { assertMarketingAdminPageAccess } from "./admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function AdminMarketingRequestsPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Marketing Requests</h1>
          <p className={pageHeaderDescriptionClassName}>
            Create draft activities, forecast product ROI, and keep request rows ready for validation.
          </p>
        </div>
      </div>
      <MarketingRequestDraftWorkspace />
    </div>
  );
}
