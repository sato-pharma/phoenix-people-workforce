import { MarketingCoverageReportWorkspace } from "@/components/marketing-requests/marketing-coverage-report-workspace";

import { assertMarketingCoverageReportAdminPageAccess } from "../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function AdminMarketingCoverageReportPage() {
  const access = await assertMarketingCoverageReportAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Marketing Coverage Report</h1>
          <p className={pageHeaderDescriptionClassName}>
            Filter every marketing request by line, region, area, hierarchy tier or a named person, see premium KPI
            totals for the current filter, then expand any request to its target pharmacies — every pharmacy shows its
            realized sales for the request, even when zero.
          </p>
        </div>
      </div>
      <MarketingCoverageReportWorkspace isSuperAdmin={access.role === "Super Admin"} />
    </div>
  );
}
