import { redirect } from "next/navigation";

import { MarketingRoiFilterEngine } from "@/components/marketing-requests/roi-filter-engine";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingRoiTrackingPage() {
  const access = await assertMarketingAdminPageAccess({ allowCompanyOversight: true });
  if (access.role === "CEO") {
    redirect("/admin/marketing-roi");
  }

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#F97316]">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">ROI Tracking</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Filter every marketing request by manager, line, approver, distributor, product, pharmacy and ROI status, then measure realized sales of the promoted products against the required return.
        </p>
      </div>
      <MarketingRoiFilterEngine viewSalesBasePath="/admin" />
    </div>
  );
}
