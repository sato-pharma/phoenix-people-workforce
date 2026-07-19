import { redirect } from "next/navigation";

import { ReconciliationDashboard } from "@/components/analytics/dashboards/reconciliation-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveAnalyticsViewerScope } from "@/lib/analytics/scope";
import { canViewAdminDetailedAnalytics } from "@/lib/analytics/portal-access";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Admin mount. Lives in the (admin) route group, so the group layout renders the admin shell and
// redirects portal-mode users away — analytics is reachable via /admin only by admin-nav roles.
// CEO / Super Admin only — the hub itself hides this tile from every other role, but that's UX,
// not the security boundary, so it's re-enforced here too.
export default async function ReconciliationAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  if (!canViewAdminDetailedAnalytics(access.role)) redirect("/admin/analytics");
  const scope = await resolveAnalyticsViewerScope(access);
  const resolvedParams = await searchParams;

  return (
    <ReconciliationDashboard searchParams={resolvedParams} role={access.role} scope={scope} mountRoot="/admin/analytics" />
  );
}
