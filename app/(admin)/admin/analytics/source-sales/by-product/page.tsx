import { SourceSalesByProductDashboard } from "@/components/analytics/dashboards/source-sales-by-product-dashboard";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { resolveAnalyticsViewerScope } from "@/lib/analytics/scope";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Admin mount (see app/(admin)/admin/analytics/source-sales/page.tsx for the pattern).
export default async function SourceSalesByProductAnalyticsPage({ searchParams }: { searchParams: SearchParams }) {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  const scope = await resolveAnalyticsViewerScope(access);
  const resolvedParams = await searchParams;

  return (
    <SourceSalesByProductDashboard searchParams={resolvedParams} role={access.role} scope={scope} mountRoot="/admin/analytics" />
  );
}
