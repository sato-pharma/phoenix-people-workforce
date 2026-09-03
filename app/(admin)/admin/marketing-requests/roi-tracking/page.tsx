import { redirect } from "next/navigation";

import { MarketingRoiFilterEngine } from "@/components/marketing-requests/roi-filter-engine";

import { assertMarketingAdminPageAccess } from "../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function AdminMarketingRoiTrackingPage() {
  const access = await assertMarketingAdminPageAccess({ allowCompanyOversight: true });
  if (access.role === "CEO") {
    redirect("/admin/marketing-roi");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>ROI Tracking</h1>
          <p className={pageHeaderDescriptionClassName}>
            Filter every marketing request by manager, line, approver, distributor, product, pharmacy and ROI status, then measure realized sales of the promoted products against the required return.
          </p>
        </div>
      </div>
      <MarketingRoiFilterEngine viewSalesBasePath="/admin" />
    </div>
  );
}
