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
 * Row visibility stays scoped per viewer inside each component's own service — this page widens
 * nothing.
 *
 * 🔴 THE COVERAGE SET'S TWO EXTRA ROLES NEVER ARRIVE HERE, and this comment used to say they did
 * ("a Finance Manager / Financial Advisor therefore sees only the Coverage tab"). Neither is in
 * `portalShellRoles`, so the shell gate a few lines below — which runs BEFORE either tab predicate
 * — sends them to /overview. Measured 2026-10-09 by a role sweep against a dev server: a Finance
 * Manager asking for this page is answered `NEXT_REDIRECT;replace;/overview`, never a Coverage tab.
 * Their Coverage Report is the ADMIN one, /admin/marketing-requests/coverage-report, which
 * `coverageReportAdminShellRoles` opened to them for exactly this reason. So the broader predicate
 * is dead weight HERE and load-bearing THERE — do not "fix" it by widening the shell gate, which
 * would hand both seats a portal they have no other page in.
 *
 * `isTerritoryScoped` marks the Medical Rep, the one seat whose ROI tab is bounded by his own area
 * AND his own LINE (owner ruling 2026-09-30, after the Pedia rep on Gharbia 2 was shown the CNS
 * District Manager's campaign — "it doesn't mean that he is the same area that he sees, he must see
 * his line"). It carries no authority: the bound is enforced server-side in roi-report-scope.ts and
 * this flag only lets the tracker's EMPTY sentence say why a rep's page is blank.
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

  // The header speaks to the tabs this viewer actually has. The ROI tab no longer draws a second
  // hero of its own under this one, so its one-line summary lives here.
  const roiSummary = "Money in flight: the stage each campaign is at, who is holding it, and the month its return can be judged.";
  const coverageSummary = "Open any request's target pharmacies and their realized sales.";
  const description =
    canSeeRoi && canSeeCoverage
      ? `${roiSummary} Coverage opens any request's target pharmacies and their realized sales, and Managers totals every person who raised requests — three views of the same campaigns.`
      : canSeeRoi
        ? `${roiSummary} Managers totals every person who raised requests.`
        : coverageSummary;

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description={description}
      title="ROI Tracker"
    >
      <RoiTrackerTabs
        canSeeCoverage={canSeeCoverage}
        // Managers — the Manager Scorecard (owner, 2026-10-09). Same audience as the ROI tab, and
        // the same server-side scope resolves its rows, so a National Sales Manager reads the
        // managers under him while an oversight role reads the company.
        canSeeManagers={canSeeRoi}
        canSeeRoi={canSeeRoi}
        isSuperAdmin={access.role === "Super Admin"}
        isTerritoryScoped={access.role === "Medical Rep"}
      />
    </EmployeePortalPageShell>
  );
}
