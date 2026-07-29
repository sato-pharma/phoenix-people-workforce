import { redirect } from "next/navigation";

import { AnalyticsModuleNav } from "@/components/analytics/analytics-module-nav";
import { ClosingDetailsStandalone } from "@/components/sales/closing-details-standalone";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canViewAdminCoreAnalytics } from "@/lib/analytics/portal-access";
import { CLOSING_TABS } from "@/lib/analytics/module-nav-config";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";

export const dynamic = "force-dynamic";

// Admin mount of the Monthly Closing "Details" tab. The rows themselves are scoped per-caller by
// /api/sales/monthly-closing/details, so this page only gates entry to the module.
export default async function ClosingDetailsPage() {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  if (!canViewAdminCoreAnalytics(access.role)) redirect("/admin/analytics");

  return (
    <div className="space-y-6">
      <AnalyticsModuleNav tabs={CLOSING_TABS} mountRoot="/admin/analytics" />
      <ClosingDetailsStandalone canRevealConfidential={canViewRestrictedProducts(access.role)} />
    </div>
  );
}
