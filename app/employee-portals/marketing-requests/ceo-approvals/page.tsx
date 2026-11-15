import { redirect } from "next/navigation";

import { EmployeePortalPageShell } from "@/components/employee-portal/enterprise-shell";
import { MarketingCeoApprovalsReport } from "@/components/marketing-requests/marketing-ceo-approvals-report";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { todayInCairo } from "@/lib/date-only";
import { canViewMarketingCeoApprovals, resolveCeoApprovalsCarry, resolveCeoApprovalsRange } from "@/lib/marketing-requests/ceo-approvals";
import { canSendMarketingCeoApprovalsEmail } from "@/lib/marketing-requests/ceo-approvals-email";
import { getMarketingCeoApprovals } from "@/lib/marketing-requests/ceo-approvals-service";

export const dynamic = "force-dynamic";

/** CEO Approvals for those who work in the portal — the Marketing Manager first (owner, 2026-11-08). */
export default async function EmployeePortalMarketingCeoApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ carry?: string | string[]; from?: string | string[]; to?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  if (!canViewMarketingCeoApprovals(access.role)) redirect("/employee-portals/marketing-requests");
  const params = await searchParams;
  const range = resolveCeoApprovalsRange(params, todayInCairo());
  const includeCarriedOver = resolveCeoApprovalsCarry(params.carry);
  const report = await getMarketingCeoApprovals(access, range, { includeCarriedOver });

  return (
    <EmployeePortalPageShell
      badge="Marketing"
      description="Every marketing request the CEO approved between two dates, with its value and where its money stands now. Tick the switch to add earlier approvals Finance has not paid yet. Untick a row to leave it out of the totals and the exports."
      title="CEO Approvals"
    >
      <MarketingCeoApprovalsReport
        canSend={canSendMarketingCeoApprovalsEmail(access.role)}
        key={`${range.from}:${range.to}:${includeCarriedOver ? 1 : 0}`}
        report={report}
      />
    </EmployeePortalPageShell>
  );
}
