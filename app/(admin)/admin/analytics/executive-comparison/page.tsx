import { ExecutiveComparisonDashboard } from "@/components/analytics/dashboards/executive-comparison-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveAnalyticsViewerScope } from "@/lib/analytics/scope";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Admin mount. Lives in the (admin) route group, so the group layout renders the admin shell and
// redirects portal-mode users away — analytics is reachable via /admin only by admin-nav roles.
export default async function ExecutiveComparisonAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  const scope = await resolveAnalyticsViewerScope(access);
  const resolvedParams = await searchParams;

  return (
    <ExecutiveComparisonDashboard searchParams={resolvedParams} role={access.role} scope={scope} mountRoot="/admin/analytics" />
  );
}
