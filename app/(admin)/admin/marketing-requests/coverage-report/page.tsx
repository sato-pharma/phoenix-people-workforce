import { MarketingCoverageReportWorkspace } from "@/components/marketing-requests/marketing-coverage-report-workspace";

import { assertMarketingCoverageReportAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingCoverageReportPage() {
  const access = await assertMarketingCoverageReportAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-phx-accent">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Marketing Coverage Report</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Filter every marketing request by line, region, area, hierarchy tier or a named person, see premium KPI
          totals for the current filter, then expand any request to its target pharmacies — every pharmacy shows its
          realized sales for the request, even when zero.
        </p>
      </div>
      <MarketingCoverageReportWorkspace isSuperAdmin={access.role === "Super Admin"} />
    </div>
  );
}
