"use client";

// Approvals WhatsApp — the Super Admin's screen for the third company number, +20 10 40631155 (the approvals line).
//
// Five tabs: Chats, Bulk send, Lists, Reports, Wordings. The owner's four answers of 19 Nov 2026 shape it: "Keep them,
// my screen only" (replies on this number are kept and shown here alone), "Super Admin only", "Phoenix people +
// pasted", "Submit from the screen". The page and every route behind it check the role; hiding the tab is not the gate.
//
// The look is the house's flat one: hairlines, square corners, no shadows or gradients, nothing that scrolls sideways.

import { useCallback, useEffect, useState } from "react";

import { getJson } from "@/components/recruitment/recruitment-fetch";
import { pageHeaderKickerClassName, pageHeaderTitleClassName } from "@/components/admin/admin-design-tokens";
import type { InboxConversationSummary } from "@/lib/whatsapp-inbox/store";
import { cn } from "@/lib/utils";

import { ApprovalsBulkSend } from "./approvals-bulk-send";
import { ApprovalsChats } from "./approvals-chats";
import { ApprovalsLists, type ApprovalsListSummaryView } from "./approvals-lists";
import { ApprovalsReports, type ApprovalsBroadcastView } from "./approvals-reports";
import { APPROVALS_API, Notice, type ApprovalsEmployeeOption } from "./approvals-shared";
import { ApprovalsWordings } from "./approvals-wordings";

type Tab = "chats" | "bulk" | "lists" | "reports" | "wordings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "chats", label: "Chats" },
  { id: "bulk", label: "Bulk send" },
  { id: "lists", label: "Lists" },
  { id: "reports", label: "Reports" },
  { id: "wordings", label: "Wordings" },
];

export function ApprovalsWhatsAppScreen({
  displayNumber,
  initialConversations,
  initialTotalUnread,
  lineId,
}: {
  displayNumber: string;
  initialConversations: InboxConversationSummary[];
  initialTotalUnread: number;
  lineId: string;
}) {
  const [tab, setTab] = useState<Tab>("chats");
  const [unread, setUnread] = useState(initialTotalUnread);
  const [employees, setEmployees] = useState<ApprovalsEmployeeOption[] | null>(null);
  const [lists, setLists] = useState<ApprovalsListSummaryView[]>([]);
  const [broadcasts, setBroadcasts] = useState<ApprovalsBroadcastView[]>([]);
  const [dailyLimit, setDailyLimit] = useState<{ limit: number; usedToday: number } | null>(null);
  const [openReport, setOpenReport] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadLists = useCallback(async () => {
    const data = await getJson(`${APPROVALS_API}/lists`);
    setLists(Array.isArray(data.lists) ? (data.lists as ApprovalsListSummaryView[]) : []);
  }, []);

  const loadBroadcasts = useCallback(async () => {
    const data = await getJson(`${APPROVALS_API}/broadcasts`);
    setBroadcasts(Array.isArray(data.broadcasts) ? (data.broadcasts as ApprovalsBroadcastView[]) : []);
    const limit = data.dailyLimit as { limit?: unknown; usedToday?: unknown } | undefined;
    setDailyLimit(limit && typeof limit.limit === "number" && typeof limit.usedToday === "number" ? { limit: limit.limit, usedToday: limit.usedToday } : null);
  }, []);

  // The employee master, the lists and the sends are read once, when a tab that needs them is first opened.
  useEffect(() => {
    if (tab === "chats" || tab === "wordings") return;
    const work: Array<Promise<unknown>> = [];
    if (employees === null && (tab === "bulk" || tab === "lists")) {
      work.push(
        getJson(`${APPROVALS_API}/recipients`).then((data) => setEmployees(Array.isArray(data.employees) ? (data.employees as ApprovalsEmployeeOption[]) : [])),
      );
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- both set state only after their awaited fetch
    work.push(loadLists(), loadBroadcasts());
    Promise.all(work)
      .then(() => setLoadError(null))
      .catch((caught: unknown) => setLoadError(caught instanceof Error ? caught.message : "Part of this tab could not be read."));
  }, [employees, loadBroadcasts, loadLists, tab]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-3 border-b border-phx-line pb-3">
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <span className={pageHeaderKickerClassName}>Approvals · WhatsApp</span>
            <h1 className={cn(pageHeaderTitleClassName, "mt-1")}>Approvals WhatsApp</h1>
            <p className="mt-1 text-[12px] text-phx-ink-soft">
              The approvals number{" "}
              <span className="font-bold tabular-nums text-phx-ink-2" dir="ltr">
                {displayNumber}
              </span>
              . Replies to it are kept here, for the Super Admin alone.
            </p>
          </div>
        </div>
        <nav aria-label="Approvals WhatsApp" className="flex flex-wrap gap-x-1 gap-y-1">
          {TABS.map((item) => (
            <button
              aria-current={tab === item.id ? "page" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-bold leading-none",
                tab === item.id ? "border-b-phx-accent text-phx-ink" : "border-b-transparent text-phx-ink-soft hover:text-phx-ink",
              )}
              key={item.id}
              onClick={() => setTab(item.id)}
              type="button"
            >
              {item.label}
              {item.id === "chats" && unread > 0 ? <span className="bg-phx-accent px-1.5 py-[3px] text-[11px] font-black leading-none tabular-nums text-white">{unread}</span> : null}
            </button>
          ))}
        </nav>
      </header>

      {loadError ? <Notice tone="warn">{loadError}</Notice> : null}

      {tab === "chats" ? (
        <ApprovalsChats initialConversations={initialConversations} initialTotalUnread={initialTotalUnread} lineId={lineId} onUnreadChange={setUnread} />
      ) : null}
      {tab === "bulk" ? (
        employees === null ? (
          <p className="text-[12px] text-phx-ink-soft">Reading the employee list</p>
        ) : (
          <ApprovalsBulkSend
            dailyLimit={dailyLimit}
            employees={employees}
            lists={lists}
            onSent={(broadcastId) => {
              void loadBroadcasts();
              setOpenReport(broadcastId);
              setTab("reports");
            }}
          />
        )
      ) : null}
      {tab === "lists" ? (
        employees === null ? (
          <p className="text-[12px] text-phx-ink-soft">Reading the employee list</p>
        ) : (
          <ApprovalsLists employees={employees} lists={lists} onChanged={loadLists} />
        )
      ) : null}
      {tab === "reports" ? <ApprovalsReports broadcasts={broadcasts} initialOpenId={openReport} key={openReport ?? "list"} onChanged={loadBroadcasts} /> : null}
      {tab === "wordings" ? <ApprovalsWordings /> : null}
    </div>
  );
}
