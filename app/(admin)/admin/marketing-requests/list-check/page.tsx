import { redirect } from "next/navigation";

import { MarketingListCheckBoard } from "@/components/marketing-requests/marketing-list-check-board";
import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";
import { loadListCheckBoard } from "@/lib/marketing-requests/crm-list-check-board-service";

import { assertMarketingListCheckAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

/**
 * Doctor-List Check: is each validated marketing customer on the rep's own Phoenix CRM list, and what
 * money and visits sit behind him (owner, 2026-11-03). It flags and never blocks a request. A failed
 * read reaches the error boundary rather than rendering as an empty board.
 */
export default async function AdminMarketingListCheckPage() {
  const access = await assertMarketingListCheckAdminPageAccess();
  // The Marketing Manager works in the portal, and reads the same board on its own page there.
  if (isPortalShellRole(access.role)) redirect("/employee-portals/marketing-requests/list-check");
  const board = await loadListCheckBoard(access);

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>Doctor-List Check</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every validated marketing customer against the rep&rsquo;s own Phoenix CRM list: the same name, on the right
            list, within 500 m. It shows the approved money behind each one and what happened after it. It flags and
            never stops a request.
          </p>
        </div>
      </div>
      <MarketingListCheckBoard board={board} />
    </div>
  );
}
