import { redirect } from "next/navigation";

import { WeeklySalesDetailDashboard } from "@/components/analytics/dashboards/weekly-sales-detail-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveAnalyticsViewerScope } from "@/lib/analytics/scope";
import { canViewPortalCoreAnalytics } from "@/lib/analytics/portal-access";
import { resolveLandingPathForRole } from "@/lib/auth/landing";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Portal mount. Lives under /employee-portals, so the employee-portal layout renders the portal
// shell. Field roles reach their OWN scoped analytics here — never through an /admin URL. Access is
// enforced by assertPermission(weekly_sales, read) + canViewPortalCoreAnalytics + the per-viewer
// AnalyticsViewerScope (confidential products / Head-Office line stay CEO/SA-excluded inside the
// scope engine).
export default async function PortalWeeklyDetailPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "weekly_sales", "read");
  if (!canViewPortalCoreAnalytics(access.role)) redirect(resolveLandingPathForRole(access.role));
  const scope = await resolveAnalyticsViewerScope(access);
  const resolvedParams = await searchParams;

  return (
    <WeeklySalesDetailDashboard searchParams={resolvedParams} role={access.role} scope={scope} mountRoot="/employee-portals/sales-analytics" />
  );
}
