import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketingCeoApprovalsReport } from "@/components/marketing-requests/marketing-ceo-approvals-report";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { todayInCairo } from "@/lib/date-only";
import { canViewMarketingCeoApprovals, resolveCeoApprovalsRange } from "@/lib/marketing-requests/ceo-approvals";
import { canSendMarketingCeoApprovalsEmail } from "@/lib/marketing-requests/ceo-approvals-email";
import { getMarketingCeoApprovals } from "@/lib/marketing-requests/ceo-approvals-service";

export const dynamic = "force-dynamic";

/** CEO Approvals for those who work in the portal — the Marketing Manager first (owner, 2026-11-08). */
export default async function EmployeePortalMarketingCeoApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!canViewMarketingCeoApprovals(access.role)) redirect("/employee-portals/marketing-requests");
  const range = resolveCeoApprovalsRange(await searchParams, todayInCairo());
  const report = await getMarketingCeoApprovals(access, range);

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Every marketing request the CEO approved between two dates, with its value and where its money stands now. Untick a row to leave it out of the totals."
      title="CEO Approvals"
    >
      <MarketingCeoApprovalsReport
        canSend={canSendMarketingCeoApprovalsEmail(access.role)}
        key={`${range.from}:${range.to}`}
        report={report}
      />
    </EmployeePortalPageShell>
  );
}
