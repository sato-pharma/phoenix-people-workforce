import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { MarketAwarenessWorkspace } from "@/components/market-awareness/market-awareness-workspace";
import { assertMarketAwarenessAdminAccess } from "@/lib/market-awareness/page-guard";
import { canCreateActivity } from "@/lib/market-awareness/scope";

export const dynamic = "force-dynamic";

/**
 * The admin-shell half of Market Awareness. Owner answer 5: BOTH shells, on separate links — one
 * admin, one for employees. Same workspace component, so the two can never drift into two different
 * behaviours; the shell around it is what differs.
 */
export default async function AdminMarketAwarenessPage() {
  const access = await assertMarketAwarenessAdminAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Market Awareness</h1>
          <p className={pageHeaderDescriptionClassName}>
            Conferences, round tables and speaker programmes raised by the product managers, with the
            brick and area sales that follow them.
          </p>
        </div>
      </div>

      <MarketAwarenessWorkspace canCreate={canCreateActivity(access)} />
    </div>
  );
}
