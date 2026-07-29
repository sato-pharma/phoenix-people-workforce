import { redirect } from "next/navigation";

import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { ClosingDetailsStandalone } from "@/components/sales/closing-details-standalone";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canViewPortalCoreAnalytics } from "@/lib/analytics/portal-access";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { CLOSING_TABS } from "@/lib/analytics/module-nav-config";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";

export const dynamic = "force-dynamic";

// Portal mount of the Monthly Closing "Details" tab. Field roles reach their OWN rows here, never
// through an /admin URL. Row-level scope (line, region, per-user product allowlist) and the
// confidential-product lock are enforced inside loadMonthlyClosingDetails on every request — this
// page only gates entry to the module.
export default async function PortalClosingDetailsPage() {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  if (!canViewPortalCoreAnalytics(access.role)) redirect(resolveLandingPathForRole(access.role));

  return (
    <div className="space-y-6">
      <AnalyticsModuleNav tabs={CLOSING_TABS} mountRoot="/employee-portals/sales-analytics" />
      <ClosingDetailsStandalone canRevealConfidential={canViewRestrictedProducts(access.role)} />
    </div>
  );
}
