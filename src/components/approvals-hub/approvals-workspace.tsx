"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Clock, Inbox, Building2, ClipboardList, Users, ListChecks, Eye, Target } from "lucide-react";

import type {
  ResponderHistoryItem,
  CompanyWideDecisionItem,
  ApprovalScopeData,
  CompanyRequestItem,
} from "@/lib/approvals-hub/service";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_ROW_LINK,
  LandingEmpty,
  LandingPanel,
  LandingRailLine,
} from "@/components/employee-portal/landing-kit";
import type { MyRequestItem } from "@/components/action-center/types";
import { MyRequestsList } from "@/components/action-center/my-requests-list";
import { SlaAgeChip, SlaAgeRail, type ApprovalsSlaModule } from "@/components/approvals-hub/sla-badge";
import { HistoryList } from "@/components/approvals-hub/history-list";
import { ApprovalScopeList } from "@/components/approvals-hub/approval-scope-list";
import { CompanyRequestsList } from "@/components/approvals-hub/company-requests-list";
import { BulkDecisionBar } from "@/components/approvals-hub/bulk-decision-bar";
import type { BulkDecisionModule } from "@/lib/approvals-hub/bulk-decide";
import { phxCheckInputClassName } from "@/components/ui/form-tokens";
import { PlanAdherenceHistoryPanel } from "@/components/weekly-planning/plan-adherence-report";
import type { PlanAdherenceHistory } from "@/lib/weekly-planning/plan-adherence";

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
  // Shown above the pending lists when part of them could not be read, so empty never reads as "nothing waiting".
  pendingNotice?: string | null;
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
  // CEO + Super Admin only — "Who I Approve" (approval scope) and "Company Requests" tabs.
  // Absent (null/undefined) hides each tab entirely.
  approvalScope?: ApprovalScopeData | null;
  approvalScopeModuleLabel?: string;
  companyRequests?: CompanyRequestItem[] | null;
  companyRequestsExportTitle?: string;
  companyRequestsEmptyLabel?: string;
  // Overrides the tab's displayed label (defaults to "Company Requests") — e.g. plans use
  // "Company Plans" for the identical pending+decided, all-roles, read-only oversight view.
  companyRequestsTabLabel?: string;
  // A second, narrower read-only oversight feed — same shape and behavior as
  // companyRequests (no decide actions, ever), just a different subset. Plans use this for
  // "District Manager Plans": those never reach a CEO decision, so without this tab the CEO
  // has no page-level visibility into them at all. Absent (null/undefined) hides the tab.
  secondaryCompanyRequests?: CompanyRequestItem[] | null;
  secondaryCompanyRequestsTabLabel?: string;
  secondaryCompanyRequestsExportTitle?: string;
  secondaryCompanyRequestsEmptyLabel?: string;
  // PLANS ONLY — the viewer's own week-by-week adherence score. Prop-gated because this workspace
  // is shared with Vacation and Excuse, and neither has anything to score: an unconditional tab
  // here would appear on all three pages and be empty on two of them.
  scoreHistory?: PlanAdherenceHistory | null;
  // A base path, not a `(planId) => href` builder: this is a client component, so a function prop
  // handed in from the server page cannot be serialised and the page 500s at render.
  scoreHistoryPlanBaseHref?: string | null;
  // Leave and Excuse only — tick boxes on the requests awaiting this viewer, with Approve all /
  // Reject all (owner, 2026-11-12). Absent leaves the inbox one-at-a-time, as Plans is.
  bulkDecisionModule?: BulkDecisionModule | null;
};

/** The white sheet a stand-alone line sits on: the kit's hairline and the soft depth token. */
const SHEET = `min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`;

/**
 * One waiting row: who (the name in full), what, and how long it has waited — the age in coloured
 * small capitals and a thin rail under the row, emerald inside the window, amber near, rose over.
 */
function Card({ card, readOnly, slaModule }: { card: PendingCard; readOnly?: boolean; slaModule: ApprovalsSlaModule }) {
  return (
    <Link href={card.href} className={`flex min-w-0 flex-col gap-2 px-3 py-3 sm:px-4 ${LANDING_ROW_LINK}`}>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          {/* Wraps, never ellipsises. The name is now the employee RECORD name, which runs to four
              and five parts here, and the owner's rule puts wrapping ahead of a truncation. The row
              grows taller, never wider: this column is min-w-0 beside a shrink-0 one. */}
          <p className="break-words text-sm font-bold text-slate-900" dir="auto">{card.employeeName}</p>
          <p className="break-words text-xs text-slate-600">{card.title}</p>
        </div>
        <div className="flex max-w-40 shrink-0 flex-col items-end gap-1 text-right">
          {/* Overdue framing only applies to items actually awaiting this viewer's action —
              not "Coming to you" or "Your own requests" (readOnly sections). */}
          {!readOnly && typeof card.ageDays === "number" ? <SlaAgeChip ageDays={card.ageDays} module={slaModule} /> : null}
          <span className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
            {readOnly ? "View" : card.statusLabel}
          </span>
        </div>
      </div>
      {!readOnly && typeof card.ageDays === "number" ? <SlaAgeRail ageDays={card.ageDays} module={slaModule} /> : null}
    </Link>
  );
}

export function ApprovalsWorkspace({
  sections,
  pendingNotice,
  history,
  pendingCount,
  initialTab = "pending",
  slaModule,
  historyExportTitle,
  historyEmptyLabel,
  myRequests,
  companyWide,
  companyWideExportTitle,
  approvalScope,
  approvalScopeModuleLabel,
  companyRequests,
  companyRequestsExportTitle,
  companyRequestsEmptyLabel,
  companyRequestsTabLabel,
  secondaryCompanyRequests,
  secondaryCompanyRequestsTabLabel,
  secondaryCompanyRequestsExportTitle,
  secondaryCompanyRequestsEmptyLabel,
  scoreHistory,
  scoreHistoryPlanBaseHref,
  bulkDecisionModule,
}: Props) {
  const router = useRouter();
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  // Only a request awaiting THIS viewer can be ticked — "Coming to you" and own requests are read-only.
  const tickableCards = bulkDecisionModule ? sections.filter((s) => !s.readOnly).flatMap((s) => s.cards) : [];
  // Derived, never stored: a request decided elsewhere (or by this bar) drops out of the selection the
  // moment the refreshed list no longer carries it.
  const tickedCards = tickableCards.filter((card) => ticked.has(card.id));
  function toggle(id: string) {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function setMany(ids: string[], on: boolean) {
    setTicked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }
  type TabKey =
    | "pending"
    | "history"
    | "my-requests"
    | "approval-scope"
    | "company-requests"
    | "secondary-company-requests"
    | "score-history"
    | "all-decisions";
  const [tab, setTab] = useState<TabKey>(initialTab);
  const showApprovalScopeTab = approvalScope != null;
  const showScoreHistoryTab = scoreHistory != null;
  const showCompanyRequestsTab = Array.isArray(companyRequests);
  const showSecondaryCompanyRequestsTab = Array.isArray(secondaryCompanyRequests);
  const showCompanyWideTab = Array.isArray(companyWide);

  const tabs: Array<{ key: TabKey; label: string; count: number; icon: typeof Inbox }> = [
    { key: "pending", label: "Response", count: pendingCount, icon: Inbox },
    { key: "history", label: "Response history", count: history.length, icon: Clock },
    { key: "my-requests", label: "My Requests", count: myRequests.length, icon: ClipboardList },
    ...(showScoreHistoryTab ? [{ key: "score-history" as const, label: "My Plan Score", count: scoreHistory.entries.length, icon: Target }] : []),
    ...(showApprovalScopeTab ? [{ key: "approval-scope" as const, label: "Who I Approve", count: approvalScope.totalPeople, icon: Users }] : []),
    ...(showCompanyRequestsTab ? [{ key: "company-requests" as const, label: companyRequestsTabLabel ?? "Company Requests", count: companyRequests.length, icon: ListChecks }] : []),
    ...(showSecondaryCompanyRequestsTab
      ? [{ key: "secondary-company-requests" as const, label: secondaryCompanyRequestsTabLabel ?? "Related Requests", count: secondaryCompanyRequests.length, icon: Eye }]
      : []),
    ...(showCompanyWideTab ? [{ key: "all-decisions" as const, label: "All Decisions", count: companyWide.length, icon: Building2 }] : []),
  ];

  return (
    <div className="space-y-5">
      {/* The tabs WRAP onto a second row: at 375px a Leave strip is 513px and a Plan strip 935px, and
          a sideways-scrolling strip hides the tabs past the edge (the fits-the-screen golden rule). */}
      {/* The kit's tab: small navy capitals on a 2px navy underline when chosen, the count a plain
          figure beside the words — never a filled orange pill. */}
      <div className="flex flex-wrap gap-x-1 border-b border-slate-200">
        {tabs.map(({ key, label, count, icon: Icon }) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px flex min-h-10 items-center gap-2 border-b-2 px-3 pb-2 pt-1 text-phx-xs font-bold uppercase tracking-[0.1em] transition-colors motion-reduce:transition-none sm:px-4 ${LANDING_FOCUS} ${
              tab === key ? `border-[#08111f] ${LANDING_INK}` : "border-transparent text-slate-500 hover:text-[#08111f]"
            }`}
          >
            <Icon aria-hidden="true" className="h-3.5 w-3.5" />
            {label}
            <span className={`tabular-nums ${tab === key ? LANDING_INK : "text-slate-400"}`}>{count}</span>
          </button>
        ))}
      </div>

      {tab === "pending" ? (
        <div className="space-y-6">
          {pendingNotice ? (
            <div role="status" className={SHEET}>
              <LandingRailLine rail="bg-rose-500">
                <span className="font-bold text-rose-700">{pendingNotice}</span>
              </LandingRailLine>
            </div>
          ) : null}
          {bulkDecisionModule && tickableCards.length > 0 ? (
            <BulkDecisionBar
              module={bulkDecisionModule}
              selected={tickedCards}
              onClear={() => setTicked(new Set())}
              onFinished={(decidedIds) => {
                setMany(decidedIds, false);
                router.refresh();
              }}
            />
          ) : null}
          {sections.every((s) => s.cards.length === 0) ? (
            pendingNotice ? null : (
              <div className={SHEET}>
                <LandingEmpty>Nothing waiting on you right now.</LandingEmpty>
              </div>
            )
          ) : (
            sections
              .filter((s) => s.cards.length > 0)
              .map((section) => {
                const tickable = Boolean(bulkDecisionModule) && !section.readOnly;
                const sectionIds = section.cards.map((card) => card.id);
                const tickedHere = sectionIds.filter((id) => ticked.has(id)).length;
                const allTicked = tickedHere === sectionIds.length;
                // A section is one kit panel: its title and count in the header, the Select all on the
                // right, and its rows on hairlines. The sentence that used to sit under the title is
                // gone (owner, 2026-11-20: no sentence under any header) — the title says it.
                return (
                  <LandingPanel
                    key={section.key}
                    title={
                      <>
                        {section.title} <span className="tabular-nums text-slate-500">{section.cards.length}</span>
                      </>
                    }
                    right={
                      tickable ? (
                        <label className={`flex min-h-11 cursor-pointer items-center gap-2 text-phx-xs font-bold uppercase tracking-[0.1em] ${LANDING_INK}`}>
                          <input
                            type="checkbox"
                            className={phxCheckInputClassName}
                            checked={allTicked}
                            ref={(element) => {
                              if (element) element.indeterminate = tickedHere > 0 && !allTicked;
                            }}
                            onChange={() => setMany(sectionIds, !allTicked)}
                          />
                          Select all ({section.cards.length})
                        </label>
                      ) : null
                    }
                  >
                    <ul className="divide-y divide-slate-200">
                      {section.cards.map((card) =>
                        tickable ? (
                          <li key={card.id} className="flex min-w-0 items-stretch">
                            <label className="flex w-11 shrink-0 cursor-pointer items-center justify-center border-r border-slate-200">
                              <input
                                type="checkbox"
                                className={phxCheckInputClassName}
                                checked={ticked.has(card.id)}
                                onChange={() => toggle(card.id)}
                                aria-label={`Tick ${card.employeeName} — ${card.title}`}
                              />
                            </label>
                            <div className="min-w-0 flex-1">
                              <Card card={card} readOnly={section.readOnly} slaModule={slaModule} />
                            </div>
                          </li>
                        ) : (
                          <li key={card.id} className="min-w-0">
                            <Card card={card} readOnly={section.readOnly} slaModule={slaModule} />
                          </li>
                        ),
                      )}
                    </ul>
                  </LandingPanel>
                );
              })
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
      ) : tab === "score-history" ? (
        <PlanAdherenceHistoryPanel
          history={scoreHistory ?? { averagePct: null, entries: [], measuredPeriods: 0, totalCheckable: 0, totalKept: 0 }}
          planBaseHref={scoreHistoryPlanBaseHref}
          emptyLabel="None of your plans has been scored yet."
        />
      ) : tab === "approval-scope" ? (
        <ApprovalScopeList
          data={approvalScope ?? { groups: [], totalPeople: 0 }}
          moduleLabel={approvalScopeModuleLabel ?? "request"}
        />
      ) : tab === "company-requests" ? (
        <CompanyRequestsList
          items={companyRequests ?? []}
          emptyLabel={companyRequestsEmptyLabel ?? "No requests found."}
          exportTitle={companyRequestsExportTitle ?? "Company Requests"}
          exportSheetName="Company Requests"
        />
      ) : tab === "secondary-company-requests" ? (
        <CompanyRequestsList
          items={secondaryCompanyRequests ?? []}
          emptyLabel={secondaryCompanyRequestsEmptyLabel ?? "No requests found."}
          exportTitle={secondaryCompanyRequestsExportTitle ?? secondaryCompanyRequestsTabLabel ?? "Related Requests"}
          exportSheetName={secondaryCompanyRequestsTabLabel ?? "Related Requests"}
        />
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
