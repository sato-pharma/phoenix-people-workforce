import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketingRequestSalesView } from "@/components/marketing-requests/marketing-request-sales-view";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

export default async function EmployeePortalMarketingViewSalesPage({
  params,
}: {
  params: Promise<{ requestId: string }>;
}) {
  const { requestId } = await params;
  await assertEmployeePortalMarketingPageAccess("roi-tracking");

  return (
    <EmployeePortalPageShell
      badge="Marketing · ROI Tracking"
      description="Realized sales of this request's promoted products at its target pharmacies — default to the ROI window, or choose a custom period range."
      title="View Sales"
    >
      <MarketingRequestSalesView requestId={requestId} viewSalesBasePath="/employee-portals" />
    </EmployeePortalPageShell>
  );
}
