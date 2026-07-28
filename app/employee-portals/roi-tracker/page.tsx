import { MarketingRoiTracker } from "@/components/marketing-requests/marketing-roi-tracker";
import { assertEmployeePortalMarketingPageAccess } from "@/lib/employee-portal/page-guards";

export const dynamic = "force-dynamic";

/**
 * ROI Tracker — employee-portal surface.
 *
 * Its OWN url and its OWN page file, deliberately: owner rule 2026-07-28 is that admin and portal
 * must not share one page. They share the SERVICE (getMarketingRoiTracker, which composes the
 * authoritative v2 engine) so the two surfaces can never disagree about a number, but the routes
 * are independent — /admin/marketing-roi-tracker and /employee-portals/roi-tracker — so either can
 * change without dragging the other with it.
 *
 * Reaches the field hierarchy the admin shell cannot: Medical Rep, District/Regional/National Sales
 * Manager, Product Manager, Group Product Manager, Marketing Manager, SFE Manager. Row visibility is
 * still scoped per viewer inside getMarketingRoiReport — this page widens nothing.
 *
 * Shows Phoenix-submitted requests only. The historical Excel import is admin-side, in Archived
 * Marketing Requests, and is not surfaced here.
 */
export default async function EmployeePortalRoiTrackerPage() {
  await assertEmployeePortalMarketingPageAccess("roi-tracking");

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <MarketingRoiTracker />
    </div>
  );
}
