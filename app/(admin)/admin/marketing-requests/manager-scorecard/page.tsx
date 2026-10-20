import { MarketingManagerScorecard } from "@/components/marketing-requests/marketing-manager-scorecard";

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
 * Marketing Manager Scorecard (owner instruction, 2026-10-09) — the marketing spend of every
 * person who raised a request, one row each, with what has actually come back.
 *
 * The page gate is ROI Tracking's own (`allowCompanyOversight: true`), not a set of its own: this
 * is the ROI report grouped by person, so its audience is that report's audience. WHICH rows a
 * viewer sees is decided server-side by `resolveMarketingRoiScope` — a National Sales Manager gets
 * the managers under him plus whoever ran a campaign on his line (owner, 2026-10-20: the Product
 * and Group Product Managers), a company-wide oversight role gets everyone.
 */
export default async function AdminMarketingManagerScorecardPage() {
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Marketing Manager Scorecard</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every manager who raised marketing requests, with how many were approved, the value of those
            requests, the ROI they forecast, and the sales that have actually come back so far — plus where each
            one stands against the rule that half of a closed campaign&rsquo;s spend must be collected before the
            next request.
          </p>
        </div>
      </div>
      <MarketingManagerScorecard />
    </div>
  );
}
