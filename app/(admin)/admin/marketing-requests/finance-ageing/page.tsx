import { MarketingFinanceAgeingDesk } from "@/components/marketing-requests/marketing-finance-ageing-desk";
import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { getMarketingFinanceAgeing } from "@/lib/marketing-requests/finance-ageing-service";

import { assertMarketingFinanceAgeingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

/**
 * Finance Ageing: approved requests waiting at the Finance Execution step, and for how long. Read-only;
 * a failed read reaches the error boundary rather than rendering as an empty queue.
 */
export default async function AdminMarketingFinanceAgeingPage() {
  const access = await assertMarketingFinanceAgeingAdminPageAccess();
  const report = await getMarketingFinanceAgeing(access);

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Finance Ageing</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every approved marketing request waiting at the Finance Execution step, oldest first, with how many
            days it has waited since it reached Finance. Nothing is executed from this page: open a request to act
            on it.
          </p>
        </div>
      </div>
      <MarketingFinanceAgeingDesk report={report} />
    </div>
  );
}
