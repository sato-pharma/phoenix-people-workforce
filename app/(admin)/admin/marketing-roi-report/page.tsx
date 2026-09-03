import { MarketingRoiReportWorkspace } from "@/components/marketing-requests/marketing-roi-report-workspace";

import { assertMarketingAdminPageAccess } from "../marketing-requests/admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

// Standalone, business-friendly ROI report — browse existing marketing requests by requester
// or by customer. Read-only; deliberately separate from the technical ROI Tracking / Filter
// Engine page (unchanged). Reuses the same ROI report + Explain ROI services, not a new
// attribution path.
export default async function MarketingRoiReportPage() {
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Marketing ROI Report</h1>
          <p className={pageHeaderDescriptionClassName}>
            Browse existing marketing requests by requester or by customer, with a simple business status,
            the main problem (if any), and the recommended next action. Technical details — including
            Source-of-Sales row IDs — are hidden by default and only shown inside a request&apos;s details.
          </p>
        </div>
      </div>
      <MarketingRoiReportWorkspace />
    </div>
  );
}
