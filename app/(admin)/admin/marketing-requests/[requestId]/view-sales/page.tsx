import { MarketingRequestSalesView } from "@/components/marketing-requests/marketing-request-sales-view";

import { assertMarketingAdminPageAccess } from "../../admin-access";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";

export const dynamic = "force-dynamic";

export default async function AdminMarketingViewSalesPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing · ROI Tracking</p>
          <h1 className={pageHeaderTitleClassName}>View Sales</h1>
          <p className={pageHeaderDescriptionClassName}>
            Realized sales of this request&rsquo;s promoted products at its target pharmacies — default to the ROI window, or choose a custom period range.
          </p>
        </div>
      </div>
      <MarketingRequestSalesView requestId={requestId} viewSalesBasePath="/admin" />
    </div>
  );
}
