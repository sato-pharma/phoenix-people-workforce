import { SourceSalesByCustomerDashboard } from "@/components/analytics/dashboards/source-sales-by-customer-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveAnalyticsViewerScope } from "@/lib/analytics/scope";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Portal mount (see app/employee-portals/sales-analytics/source-sales/page.tsx for the pattern).
export default async function PortalSourceSalesByCustomerAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  const scope = await resolveAnalyticsViewerScope(access);
  const resolvedParams = await searchParams;

  return (
    <SourceSalesByCustomerDashboard searchParams={resolvedParams} role={access.role} scope={scope} mountRoot="/employee-portals/sales-analytics" />
  );
}
