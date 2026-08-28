"use client";

import { useState } from "react";
import { Clock, ClipboardList, FileSearch, Inbox } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { ActionCenterHub } from "@/components/action-center/action-center-hub";
import { HistoricalApprovalsList } from "@/components/action-center/historical-approvals-list";
import { MyRequestsList } from "@/components/action-center/my-requests-list";
import type { ActionHubData, ActionHubModule, HistoricalApprovalItem, MyRequestItem } from "@/components/action-center/types";
import { PrivateCalendarDisputesWorkspace, type AdminPrivateCalendarDispute } from "@/components/admin/private-calendar-disputes-workspace";

type ActionsTab = "inbox" | "mine" | "historical" | "disputes";

type Props = {
  inboxData: ActionHubData;
  myRequests: MyRequestItem[];
  historicalItems: HistoricalApprovalItem[];
  initialModule?: ActionHubModule | null;
  initialId?: string | null;
  callerRole?: string | null;
  initialTab: ActionsTab;
  // When rendered inside the employee-portal shell (which supplies its own page header),
  // skip the admin page hero and just render the tabs + content.
  embedded?: boolean;
  // Present only for Super Admin callers — undefined means "not this caller's tab", so the
  // tab itself is left out of the array rather than rendered empty. Private-calendar data
  // disputes are Super-Admin-only end to end (see assertDisputeDecisionActor), so this stays
  // opt-in instead of a generic module in the shared My Requests/History aggregators.
  disputes?: AdminPrivateCalendarDispute[] | null;
};

export function ActionsWorkspace({
  inboxData,
  myRequests,
  historicalItems,
  initialModule,
  initialId,
  callerRole,
  initialTab,
  embedded,
  disputes,
}: Props) {
  const [tab, setTab] = useState<ActionsTab>(initialTab);

  const tabs: Array<{ key: ActionsTab; label: string; count: number; icon: typeof Inbox }> = [
    { key: "inbox", label: "Pending approvals", count: inboxData.items.length, icon: Inbox },
    { key: "mine", label: "My requests", count: myRequests.length, icon: ClipboardList },
    { key: "historical", label: "Approval history", count: historicalItems.length, icon: Clock },
    ...(disputes ? [{ key: "disputes" as const, label: "Disputes Inbox", count: disputes.length, icon: FileSearch }] : []),
  ];

  return (
    <div className="space-y-5">
      {!embedded && (
        <AdminPageHero
          badges={(
            <>
              <AdminInsightChip tone={inboxData.items.length > 0 ? "orange" : "slate"}>
                {inboxData.items.length} awaiting me
              </AdminInsightChip>
              <AdminInsightChip tone="slate">{myRequests.length} my requests</AdminInsightChip>
            </>
          )}
          description="Approvals waiting on your decision, the live status of your requests, and your full approval history."
          eyebrow="Phoenix Workforce"
          icon={<Inbox className="h-3.5 w-3.5" />}
          title="Approvals Hub"
        />
      )}

      <div className="flex gap-1 border-b border-[#E5EAF1]">
        {tabs.map(({ key, label, count, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 pb-2.5 pt-1 text-sm font-bold transition-colors ${
              tab === key
                ? "border-b-2 border-orange-500 text-slate-900"
                : "border-b-2 border-transparent text-slate-400 hover:text-slate-600"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            <span
              className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-phx-2xs font-black leading-none ${
                tab === key ? "bg-orange-500 text-white" : "bg-slate-200/80 text-slate-500"
              }`}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {tab === "inbox" ? (
        <ActionCenterHub
          embedded
          initialData={inboxData}
          initialModule={initialModule}
          initialId={initialId}
          callerRole={callerRole}
        />
      ) : tab === "mine" ? (
        <MyRequestsList items={myRequests} initialModule={initialModule} initialId={initialId} />
      ) : tab === "disputes" ? (
        <PrivateCalendarDisputesWorkspace initialDisputes={disputes ?? []} initialError={null} />
      ) : (
        <HistoricalApprovalsList items={historicalItems} />
      )}
    </div>
  );
}
