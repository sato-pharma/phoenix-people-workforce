"use client";

import { useState } from "react";
import { ClipboardList, Inbox } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { ActionCenterHub } from "@/components/action-center/action-center-hub";
import { MyRequestsList } from "@/components/action-center/my-requests-list";
import type { ActionHubData, ActionHubModule, MyRequestItem } from "@/components/action-center/types";

type ActionsTab = "inbox" | "mine";

type Props = {
  inboxData: ActionHubData;
  myRequests: MyRequestItem[];
  initialModule?: ActionHubModule | null;
  initialId?: string | null;
  callerRole?: string | null;
  initialTab: ActionsTab;
  // When rendered inside the employee-portal shell (which supplies its own page header),
  // skip the admin page hero and just render the tabs + content.
  embedded?: boolean;
};

export function ActionsWorkspace({
  inboxData,
  myRequests,
  initialModule,
  initialId,
  callerRole,
  initialTab,
  embedded,
}: Props) {
  const [tab, setTab] = useState<ActionsTab>(initialTab);

  const tabs: Array<{ key: ActionsTab; label: string; count: number; icon: typeof Inbox }> = [
    { key: "inbox", label: "Awaiting my action", count: inboxData.items.length, icon: Inbox },
    { key: "mine", label: "My requests", count: myRequests.length, icon: ClipboardList },
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
          description="Approvals waiting on your decision, and the live status of the requests you submitted — in one place."
          eyebrow="Phoenix Workforce"
          icon={<Inbox className="h-3.5 w-3.5" />}
          title="Actions"
        />
      )}

      <div className="flex gap-1 border-b border-slate-200">
        {tabs.map(({ key, label, count, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 pb-2 pt-1 text-sm font-bold transition-colors ${
              tab === key
                ? "border-b-2 border-orange-500 text-orange-600"
                : "text-slate-400 hover:text-slate-600"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            <span
              className={`inline-flex min-w-[1.25rem] items-center justify-center px-1.5 py-0.5 text-[10px] font-black leading-none ${
                tab === key ? "bg-orange-500 text-white" : "bg-slate-200 text-slate-600"
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
      ) : (
        <MyRequestsList items={myRequests} />
      )}
    </div>
  );
}
