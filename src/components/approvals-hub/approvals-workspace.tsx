"use client";

import { useState } from "react";
import Link from "next/link";
import { Clock, Inbox, Building2, ClipboardList } from "lucide-react";

import type { ResponderHistoryItem, CompanyWideDecisionItem } from "@/lib/approvals-hub/service";
import type { MyRequestItem } from "@/components/action-center/types";
import { MyRequestsList } from "@/components/action-center/my-requests-list";
import { SlaAgeChip, type ApprovalsSlaModule } from "@/components/approvals-hub/sla-badge";
import { HistoryList } from "@/components/approvals-hub/history-list";

export type PendingCard = {
  id: string;
  href: string;
  employeeName: string;
  title: string;
  statusLabel: string;
  ageDays?: number | null;
};

export type WorkspaceSection = {
  key: string;
  title: string;
  subtitle?: string;
  readOnly?: boolean;
  cards: PendingCard[];
};

type Props = {
  sections: WorkspaceSection[];
  history: ResponderHistoryItem[];
  // The pending tab count shown in the tab (actionable-now only).
  pendingCount: number;
  initialTab?: "pending" | "history" | "my-requests" | "all-decisions";
  // Which SLA threshold applies to this page's cards (leave = 3 business days, excuse = 2).
  slaModule: ApprovalsSlaModule;
  // Export/empty-state copy differs between the Vacation and Excuse pages.
  historyExportTitle: string;
  historyEmptyLabel: string;
  // The caller's own submissions for this module — pending AND decided, one report. An item
  // never leaves this list when it's decided; its status just updates in place.
  myRequests: MyRequestItem[];
  // Company-wide "All Decisions" tab — present only for Super Admin / system-scope viewers.
  // Absent (null/undefined) hides the tab entirely for everyone else.
  companyWide?: CompanyWideDecisionItem[] | null;
  companyWideExportTitle?: string;
};

function Card({ card, readOnly, slaModule }: { card: PendingCard; readOnly?: boolean; slaModule: ApprovalsSlaModule }) {
  return (
    <Link
      href={card.href}
      className="flex items-center justify-between gap-3 border border-[#e4e9ec] bg-white px-4 py-3 transition-colors hover:border-orange-400 hover:bg-orange-50/40"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-bold text-slate-900">{card.employeeName}</p>
        <p className="truncate text-xs text-slate-600">{card.title}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* Overdue framing only applies to items actually awaiting this viewer's action —
            not "Coming to you" or "Your own requests" (readOnly sections). */}
        {!readOnly && typeof card.ageDays === "number" ? <SlaAgeChip ageDays={card.ageDays} module={slaModule} /> : null}
        <span className="whitespace-nowrap border border-slate-300 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-600">
          {readOnly ? "View" : card.statusLabel}
        </span>
      </div>
    </Link>
  );
}

export function ApprovalsWorkspace({
  sections,
  history,
  pendingCount,
  initialTab = "pending",
  slaModule,
  historyExportTitle,
  historyEmptyLabel,
  myRequests,
  companyWide,
  companyWideExportTitle,
}: Props) {
  type TabKey = "pending" | "history" | "my-requests" | "all-decisions";
  const [tab, setTab] = useState<TabKey>(initialTab);
  const showCompanyWideTab = Array.isArray(companyWide);

  const tabs: Array<{ key: TabKey; label: string; count: number; icon: typeof Inbox }> = [
    { key: "pending", label: "Response", count: pendingCount, icon: Inbox },
    { key: "history", label: "Response history", count: history.length, icon: Clock },
    { key: "my-requests", label: "My Requests", count: myRequests.length, icon: ClipboardList },
    ...(showCompanyWideTab ? [{ key: "all-decisions" as const, label: "All Decisions", count: companyWide.length, icon: Building2 }] : []),
  ];

  return (
    <div className="space-y-5">
      <div className="flex gap-1 border-b border-[#e4e9ec]">
        {tabs.map(({ key, label, count, icon: Icon }) => (
          <button
            key={key}
            type="button"
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
              className={`inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-black leading-none ${
                tab === key ? "bg-orange-500 text-white" : "bg-slate-200/80 text-slate-500"
              }`}
            >
              {count}
            </span>
          </button>
        ))}
      </div>

      {tab === "pending" ? (
        <div className="space-y-6">
          {sections.every((s) => s.cards.length === 0) ? (
            <p className="border border-[#e4e9ec] bg-white px-4 py-8 text-center text-sm text-slate-500">
              Nothing waiting on you right now.
            </p>
          ) : (
            sections
              .filter((s) => s.cards.length > 0)
              .map((section) => (
                <section key={section.key} className="space-y-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">{section.title}</h3>
                    <span className="text-[11px] font-bold text-slate-400">{section.cards.length}</span>
                  </div>
                  {section.subtitle ? <p className="text-xs text-slate-500">{section.subtitle}</p> : null}
                  <div className="space-y-2">
                    {section.cards.map((card) => (
                      <Card key={card.id} card={card} readOnly={section.readOnly} slaModule={slaModule} />
                    ))}
                  </div>
                </section>
              ))
          )}
        </div>
      ) : tab === "history" ? (
        <HistoryList
          items={history}
          emptyLabel={historyEmptyLabel}
          exportTitle={historyExportTitle}
          exportSheetName="Response History"
        />
      ) : tab === "my-requests" ? (
        <MyRequestsList items={myRequests} />
      ) : (
        <HistoryList
          items={companyWide ?? []}
          emptyLabel="No decisions recorded yet."
          exportTitle={companyWideExportTitle ?? "All Decisions"}
          exportSheetName="All Decisions"
          showDecidedBy
        />
      )}
    </div>
  );
}
