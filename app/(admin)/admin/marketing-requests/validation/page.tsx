import { MarketingValidationWorkspace } from "@/components/employee-portal/marketing-validation-workspace";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingValidationPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Customer Validation</h1>
        <p className="max-w-none overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-medium leading-6 text-slate-600">
          Validate healthcare providers, pharmacy locations, and distributor pharmacy codes before they can feed activity requests.
        </p>
      </div>
      <MarketingValidationWorkspace />
    </div>
  );
}
