import { MarketingRequestInbox } from "@/components/employee-portal/marketing-request-inbox";

import { assertMarketingAdminPageAccess } from "../admin-access";

export const dynamic = "force-dynamic";

export default async function AdminMarketingInboxPage() {
  await assertMarketingAdminPageAccess({ approvalInbox: true });

  return (
    <div className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-sky-700">Marketing</p>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">Approval Inbox</h1>
        <p className="max-w-3xl text-sm text-slate-600">
          Every marketing request that involves you, one queue at a time — waiting on your decision, coming to you
          later in the chain, or open for your comment — with what it costs and how long it has been sitting shown
          before you read a word of it. The History tab holds every request already approved, rejected or returned,
          with the full decision trail.
        </p>
      </div>
      {/* MarketingRequestInbox defaults decisionBasePath to the PORTAL. This page is the admin
          shell and its principal user is the SFE Manager, an admin-shell role — without this prop
          an SFE clicking "Validate & Forward" was thrown out to /employee-portals mid-decision. */}
      <MarketingRequestInbox decisionBasePath="/workspace/marketing-requests/decision" />
    </div>
  );
}
