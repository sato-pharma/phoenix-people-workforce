import { redirect } from "next/navigation";

import { MarketingCeoApprovalsReport } from "@/components/marketing-requests/marketing-ceo-approvals-report";
import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { isPortalShellRole } from "@/lib/auth/portal-shell-roles";
import { todayInCairo } from "@/lib/date-only";
import { MARKETING_CEO_APPROVALS_PORTAL_PATH, resolveCeoApprovalsRange } from "@/lib/marketing-requests/ceo-approvals";
import { getMarketingCeoApprovals } from "@/lib/marketing-requests/ceo-approvals-service";

import { assertMarketingCeoApprovalsAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

/**
 * CEO Approvals: every marketing request the CEO approved between two Cairo dates, with where its
 * money stands now (owner, 2026-11-08). Read-only. A failed read reaches the error boundary rather
 * than rendering as an empty table.
 */
export default async function AdminMarketingCeoApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const access = await assertMarketingCeoApprovalsAdminPageAccess();
  const params = await searchParams;
  // The Marketing Manager works in the portal, and reads the same report on its own page there.
  if (isPortalShellRole(access.role)) {
    const query = new URLSearchParams();
    for (const key of ["from", "to"] as const) {
      const value = params[key];
      if (typeof value === "string" && value) query.set(key, value);
    }
    redirect(query.size ? `${MARKETING_CEO_APPROVALS_PORTAL_PATH}?${query.toString()}` : MARKETING_CEO_APPROVALS_PORTAL_PATH);
  }
  const range = resolveCeoApprovalsRange(params, todayInCairo());
  const report = await getMarketingCeoApprovals(access, range);

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="relative pb-4">
        <span aria-hidden="true" className={`absolute inset-x-0 bottom-0 ${pageHeaderRuleClassName}`} />
        <div className="relative min-w-0 space-y-1.5 pl-3.5">
          <span aria-hidden="true" className={pageHeaderRailClassName} />
          <p className={pageHeaderKickerClassName}>Marketing</p>
          <h1 className={pageHeaderTitleClassName}>CEO Approvals</h1>
          <p className={pageHeaderDescriptionClassName}>
            Every marketing request the CEO approved between two dates, with its value and where its money stands
            now. Untick a row to leave it out of the totals.
          </p>
        </div>
      </div>
      <MarketingCeoApprovalsReport key={`${range.from}:${range.to}`} report={report} />
    </div>
  );
}
