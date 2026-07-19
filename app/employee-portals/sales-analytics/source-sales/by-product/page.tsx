import { redirect } from "next/navigation";

import { SourceSalesByProductDashboard } from "@/components/analytics/dashboards/source-sales-by-product-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveAnalyticsViewerScope } from "@/lib/analytics/scope";
import { canViewPortalCoreAnalytics } from "@/lib/analytics/portal-access";
import { resolveLandingPathForRole } from "@/lib/auth/landing";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Portal mount (see app/employee-portals/sales-analytics/source-sales/page.tsx for the pattern).
export default async function PortalSourceSalesByProductAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  if (!canViewPortalCoreAnalytics(access.role)) redirect(resolveLandingPathForRole(access.role));
  const scope = await resolveAnalyticsViewerScope(access);
  const resolvedParams = await searchParams;

  return (
    <SourceSalesByProductDashboard searchParams={resolvedParams} role={access.role} scope={scope} mountRoot="/employee-portals/sales-analytics" />
  );
}
