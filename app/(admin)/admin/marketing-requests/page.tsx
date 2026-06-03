import { MarketingRequestDraftWorkspace } from "@/components/employee-portal/marketing-request-drafts";

import { assertMarketingAdminPageAccess } from "./admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingRequestsPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Marketing Requests</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Create draft activities, forecast product ROI, and keep request rows ready for validation.
        </p>
      </div>
      <MarketingRequestDraftWorkspace />
    </div>
  );
}
