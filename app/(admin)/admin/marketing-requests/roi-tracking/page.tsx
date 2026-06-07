import { MarketingRoiTrackingWorkspace } from "@/components/employee-portal/marketing-roi-tracking-workspace";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingRoiTrackingPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">ROI Tracking</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Realized sales of the promoted products in each request, at its pharmacies, within its ROI window, measured against the required return.
        </p>
      </div>
      <MarketingRoiTrackingWorkspace />
    </div>
  );
}
