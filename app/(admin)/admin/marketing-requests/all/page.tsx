import { MarketingAllRequests } from "@/components/employee-portal/marketing-all-requests";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

/**
 * Admin-shell twin of the portal register. Same component, same data — Marketing Manager and SFE
 * Manager reach it through the portal, Super Admin through the admin sidebar, exactly like the
 * Approval Inbox above it.
 */
export default async function AdminMarketingAllRequestsPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">All Marketing Requests</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Every marketing request raised on the system, with the approval step each one is waiting on.
        </p>
      </div>
      <MarketingAllRequests />
    </div>
  );
}
