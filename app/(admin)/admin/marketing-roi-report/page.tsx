import { MarketingRoiReportWorkspace } from "@/components/marketing-requests/marketing-roi-report-workspace";

import { assertMarketingAdminPageAccess } from "../marketing-requests/admin-access";

export const dynamic = "force-dynamic";

// Standalone, business-friendly ROI report — browse existing marketing requests by requester
// or by customer. Read-only; deliberately separate from the technical ROI Tracking / Filter
// Engine page (unchanged). Reuses the same ROI report + Explain ROI services, not a new
// attribution path.
export default async function MarketingRoiReportPage() {
  await assertMarketingAdminPageAccess({ allowCompanyOversight: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#F97316]">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Marketing ROI Report</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Browse existing marketing requests by requester or by customer, with a simple business status,
          the main problem (if any), and the recommended next action. Technical details — including
          Source-of-Sales row IDs — are hidden by default and only shown inside a request&apos;s details.
        </p>
      </div>
      <MarketingRoiReportWorkspace />
    </div>
  );
}
