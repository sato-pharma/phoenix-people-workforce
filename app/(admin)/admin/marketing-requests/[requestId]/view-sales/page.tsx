import { MarketingRequestSalesView } from "@/components/marketing-requests/marketing-request-sales-view";

import { assertMarketingAdminPageAccess } from "../../admin-access";

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
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-phx-accent">Marketing · ROI Tracking</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">View Sales</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Realized sales of this request&rsquo;s promoted products at its target pharmacies — default to the ROI window, or choose a custom period range.
        </p>
      </div>
      <MarketingRequestSalesView requestId={requestId} viewSalesBasePath="/admin" />
    </div>
  );
}
