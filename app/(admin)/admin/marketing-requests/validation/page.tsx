import { MarketingValidationWorkspace } from "@/components/employee-portal/marketing-validation-workspace";

import { assertMarketingAdminPageAccess } from "../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function AdminMarketingValidationPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Customer Validation</h1>
          <p className={pageHeaderDescriptionClassName}>
            Validate healthcare providers, pharmacy locations, and distributor pharmacy codes before they can feed activity requests.
          </p>
        </div>
      </div>
      <MarketingValidationWorkspace />
    </div>
  );
}
