"use client";

import { useState } from "react";
import { Clock, ClipboardList, FileSearch, Inbox, UserCheck } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { ActionCenterHub } from "@/components/action-center/action-center-hub";
import { DecidedForMeList } from "@/components/action-center/decided-for-me-list";
import { HistoricalApprovalsList } from "@/components/action-center/historical-approvals-list";
import { MyRequestsList } from "@/components/action-center/my-requests-list";
import type { ActionHubData, ActionHubModule, HistoricalApprovalItem, MyRequestItem } from "@/components/action-center/types";
import type { DecidedForMeItem } from "@/lib/action-center/decided-for-me";
import { PrivateCalendarDisputesWorkspace, type AdminPrivateCalendarDispute } from "@/components/admin/private-calendar-disputes-workspace";

type ActionsTab = "inbox" | "mine" | "historical" | "decided_for_me" | "disputes";

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
  // Decisions somebody else took on this viewer's own team and lines — what happened while he
  // was away. The tab is omitted entirely when there are none, exactly like Disputes above: an
  // always-present empty tab is noise for the many managers nobody has ever covered for.
  decidedForMe?: DecidedForMeItem[] | null;
  decidedForMeWindowDays?: number;
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
  decidedForMe,
  decidedForMeWindowDays = 90,
}: Props) {
  const [tab, setTab] = useState<ActionsTab>(initialTab);
  const decidedForMeItems = decidedForMe ?? [];

  const tabs: Array<{ key: ActionsTab; label: string; count: number; icon: typeof Inbox }> = [
    { key: "inbox", label: "Pending approvals", count: inboxData.items.length, icon: Inbox },
    { key: "mine", label: "My requests", count: myRequests.length, icon: ClipboardList },
    { key: "historical", label: "Approval history", count: historicalItems.length, icon: Clock },
    ...(decidedForMeItems.length > 0
      ? [{ key: "decided_for_me" as const, label: "Decided for you", count: decidedForMeItems.length, icon: UserCheck }]
      : []),
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

      {/* flex-wrap, never a scroller: five tabs do not fit a 375px screen on one line, and the
          house rule forbids a horizontal scroll anywhere. */}
      <div className="flex flex-wrap gap-1 border-b border-[#E5EAF1]">
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
      ) : tab === "decided_for_me" ? (
        <DecidedForMeList items={decidedForMeItems} windowDays={decidedForMeWindowDays} />
      ) : (
        <HistoricalApprovalsList items={historicalItems} />
      )}
    </div>
  );
}
