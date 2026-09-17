import { redirect } from "next/navigation";

import { ClosingDetailsStandalone } from "@/components/sales/closing-details-standalone";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { canOpenClosingDetailsPage } from "@/lib/sales/closing-details-page-access";
import { canViewRestrictedProducts } from "@/lib/sales/access-scope";

export const dynamic = "force-dynamic";

// The Monthly Closing export page — the Finance Manager's Monthly Closing row. It is the only page
// left at /admin/analytics: the Sales Analytics module around it was retired on 2026-09-17 (owner),
// and next.config.ts redirects the module's other addresses. It keeps its address so his row and
// any bookmark still land here, and it lost only the module's tab strip, whose tabs were retired.
// The rows themselves are scoped per-caller by /api/sales/monthly-closing/details, so this page
// only gates entry.
export default async function ClosingDetailsPage() {
  const access = await resolveAuthenticatedPageAccess();
  await assertPermission(access, "sales", "read");
  if (!canOpenClosingDetailsPage(access.role)) redirect(resolveLandingPathForRole(access.role));

  return (
    <div className="space-y-6">
      <ClosingDetailsStandalone canRevealConfidential={canViewRestrictedProducts(access.role)} />
    </div>
  );
}
