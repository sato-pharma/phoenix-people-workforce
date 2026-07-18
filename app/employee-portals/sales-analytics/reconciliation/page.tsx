import { redirect } from "next/navigation";

import { ReconciliationDashboard } from "@/components/analytics/dashboards/reconciliation-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveAnalyticsViewerScope } from "@/lib/analytics/scope";
import { canViewPortalDetailedAnalytics } from "@/lib/analytics/portal-access";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Portal mount. Lives under /employee-portals, so the employee-portal layout renders the portal
// shell. Field roles reach their OWN scoped analytics here — never through an /admin URL. Access is
// enforced by assertPermission(sales, read) + the per-viewer AnalyticsViewerScope (confidential
// products / Head-Office line stay CEO/SA-excluded inside the scope engine). Reconciliation is a
// DETAILED-tier dashboard: Medical Rep and District Manager get the core three only, so they are
// sent back to the hub (see canViewPortalDetailedAnalytics / the tile matrix).
export default async function PortalReconciliationAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  if (!canViewPortalDetailedAnalytics(access.role)) redirect("/employee-portals/sales-analytics");
  const scope = await resolveAnalyticsViewerScope(access);
  const resolvedParams = await searchParams;

  return (
    <ReconciliationDashboard searchParams={resolvedParams} role={access.role} scope={scope} mountRoot="/employee-portals/sales-analytics" />
  );
}
