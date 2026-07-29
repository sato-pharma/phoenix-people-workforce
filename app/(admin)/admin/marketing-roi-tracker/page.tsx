import { MarketingRoiLiveTracker } from "@/components/marketing-requests/marketing-roi-live-tracker";

import { assertMarketingAdminPageAccess } from "../marketing-requests/admin-access";

export const dynamic = "force-dynamic";

/**
 * ROI Tracker — Phoenix-submitted campaigns, the live pipeline.
 *
 * Renders MarketingRoiLiveTracker, NOT the archive's MarketingRoiTracker. The two surfaces share
 * the service (so their numbers can never disagree) but not the shape: the archive is a closed
 * post-mortem organised by outcome, while this is money in flight organised by lifecycle stage and
 * by the month each campaign becomes judgeable. See the header of marketing-roi-live-tracker.tsx.
 *
 * Deliberately does NOT carry the CEO redirect that /admin/marketing-requests/roi-tracking has.
 * That redirect sends the CEO to a hub of links even though the guard admits them, which is the
 * opposite of what an executive source of truth should do. `allowCompanyOversight: true` is the
 * same gate ROI Tracking uses, so nobody gains access they did not already have — the CEO simply
 * stops being bounced out of the page built for them.
 */
export default async function AdminMarketingRoiTrackerPage() {
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <MarketingRoiLiveTracker />
    </div>
  );
}
