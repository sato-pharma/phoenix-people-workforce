import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { RoiTrackerTabs } from "@/components/marketing-requests/roi-tracker-tabs";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import {
  canUseEmployeePortalMarketingCoverageReport,
  canUseEmployeePortalMarketingRoiTracking,
} from "@/lib/employee-portal/navigation";

export const dynamic = "force-dynamic";

/**
 * ROI Tracker — the merged marketing-ROI module (owner instruction, 2026-09-22).
 *
 * ONE page, two tabs: the live ROI pipeline (MarketingRoiLiveTracker) and the coverage report
 * (MarketingCoverageReportWorkspace). These used to be two separate sidebar links —
 * /employee-portals/roi-tracker and /employee-portals/marketing-requests/coverage-report — showing
 * genuinely different data; the owner asked for them combined as two tabs of one module rather than
 * two pages. The old coverage route now redirects here with ?tab=coverage.
 *
 * The two tabs have DIFFERENT audiences, so this page admits the UNION and each tab is gated
 * individually inside RoiTrackerTabs:
 *   · ROI      — the 10 marketingRequestRoles (canUseEmployeePortalMarketingRoiTracking).
 *   · Coverage — those 10 PLUS Finance Manager and Financial Advisor
 *                (canUseEmployeePortalMarketingCoverageReport, deliberately broader).
 * A Finance Manager / Financial Advisor therefore sees only the Coverage tab. Row visibility stays
 * scoped per viewer inside each component's own service — this page widens nothing.
 *
 * Kept as its OWN url and page file, still separate from /admin/marketing-roi-tracker (owner rule
 * 2026-07-28: admin and portal must not share one page).
 */
export default async function EmployeePortalRoiTrackerPage() {
  const access = await resolveAccessContextFromPage();

  // Mirrors assertEmployeePortalMarketingPageAccess's shell gate: an admin-navigation-mode role has
  // no working portal route and is bounced to its own overview rather than shown a degraded page.
  if (resolveNavigationMode(access) !== "employee-portal") {
    redirect("/overview");
  }

  const canSeeRoi = canUseEmployeePortalMarketingRoiTracking(access.role);
  const canSeeCoverage = canUseEmployeePortalMarketingCoverageReport(access.role);
  if (!canSeeRoi && !canSeeCoverage) {
    redirect("/employee-portals");
  }

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Track the realized return on approved marketing spend, then switch to Coverage to expand any request to its target pharmacies and their realized sales — two views of the same campaigns."
      title="ROI Tracker"
    >
      <RoiTrackerTabs
        canSeeCoverage={canSeeCoverage}
        canSeeRoi={canSeeRoi}
        isSuperAdmin={access.role === "Super Admin"}
      />
    </EmployeePortalPageShell>
  );
}
