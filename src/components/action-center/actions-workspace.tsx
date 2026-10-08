"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowUpRight, Clock, ClipboardList, Inbox, UserCheck } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { ActionCenterHub } from "@/components/action-center/action-center-hub";
import { DecidedForMeList } from "@/components/action-center/decided-for-me-list";
import { HistoricalApprovalsList } from "@/components/action-center/historical-approvals-list";
import { MyRequestsList } from "@/components/action-center/my-requests-list";
import type { ActionHubData, ActionHubModule, HistoricalApprovalItem, MyRequestItem } from "@/components/action-center/types";
import type { DecidedForMeItem } from "@/lib/action-center/decided-for-me";

type ActionsTab = "inbox" | "mine" | "historical" | "decided_for_me";

/**
 * One queue that used to appear in here and now has a mailbox of its own.
 *
 * Owner, 2026-10-08 — three instructions in one breath: *"separate the disputes inbox into a
 * separate dispute inbox"*, *"since I have the expense approvals outside in a separate mailbox,
 * don't show any related expense approvals in the Other Approvals"*, and *"the direct orders, why do
 * I see direct orders here? make a separate inbox for the direct orders"*.
 *
 * Removing them silently would only turn "why is this here?" into "where did it go?" — so each one is
 * named with its destination, right under the tabs. **The list is resolved on the SERVER** (the admin
 * hub page) against the viewer's own grants: a link to a mailbox that bounces the reader straight
 * back out would be worse than no link at all.
 */
export type MovedOutQueue = { href: string; label: string };

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
  // The mailboxes this VIEWER can actually open, named under the tabs — see MovedOutQueue. Empty or
  // absent renders no strip at all, which is the portal's case: none of them exist in that shell.
  movedOutQueues?: ReadonlyArray<MovedOutQueue>;
  // Decisions somebody else took on this viewer's own team and lines — what happened while he
  // was away. The tab is omitted entirely when there are none: an always-present empty tab is
  // noise for the many managers nobody has ever covered for.
  //
  // THREE states, not two. `undefined` = not fetched for this caller. `[]` = fetched, nothing to
  // report. `null` = the lookup FAILED — and that must not render as an empty list, because
  // "nothing was decided for you" is exactly the wrong thing to tell someone back from leave.
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
  movedOutQueues,
  decidedForMe,
  decidedForMeWindowDays = 90,
}: Props) {
  const [tab, setTab] = useState<ActionsTab>(initialTab);
  const decidedForMeFailed = decidedForMe === null;
  const decidedForMeItems = decidedForMe ?? [];

  const tabs: Array<{ key: ActionsTab; label: string; count: number; icon: typeof Inbox }> = [
    { key: "inbox", label: "Pending approvals", count: inboxData.items.length, icon: Inbox },
    { key: "mine", label: "My requests", count: myRequests.length, icon: ClipboardList },
    { key: "historical", label: "Approval history", count: historicalItems.length, icon: Clock },
    ...(decidedForMeItems.length > 0 || decidedForMeFailed
      ? [{ key: "decided_for_me" as const, label: "Decided for you", count: decidedForMeItems.length, icon: UserCheck }]
      : []),
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
          description="Resignations and contract renewals waiting on your decision, the live status of your own requests, and your approval history. Expenses, direct orders and calendar disputes each have their own inbox."
          eyebrow="Phoenix Workforce"
          icon={<Inbox className="h-3.5 w-3.5" />}
          title="Approvals Hub"
        />
      )}

      {/* flex-wrap, never a scroller: four tabs do not fit a 375px screen on one line, and the
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

      {/* Where the queues that LEFT this hub now live. flex-wrap, so three links never make a
          scroller. */}
      {movedOutQueues && movedOutQueues.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border border-slate-200 bg-slate-50 px-3 py-2">
          <span className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Each in its own inbox</span>
          {movedOutQueues.map(({ href, label }) => (
            <Link
              className="inline-flex items-center gap-1 text-sm font-bold text-slate-700 underline decoration-slate-300 underline-offset-2 hover:text-orange-600"
              href={href}
              key={href}
            >
              {label}
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ))}
        </div>
      ) : null}

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
      ) : tab === "decided_for_me" ? (
        <DecidedForMeList items={decidedForMeItems} windowDays={decidedForMeWindowDays} failed={decidedForMeFailed} />
      ) : (
        <HistoricalApprovalsList items={historicalItems} />
      )}
    </div>
  );
}
