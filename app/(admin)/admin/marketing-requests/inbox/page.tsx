import { MarketingRequestInbox } from "@/components/employee-portal/marketing-request-inbox";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingInboxPage() {
  await assertMarketingAdminPageAccess();

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Approval Inbox</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Marketing requests that are currently waiting for your approval decision. Approve, return, or reject each one.
        </p>
      </div>
      <MarketingRequestInbox />
    </div>
  );
}
