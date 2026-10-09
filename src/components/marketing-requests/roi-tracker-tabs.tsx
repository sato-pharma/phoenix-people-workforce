"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ROI Tracker — the tab shell that merges the marketing-ROI surfaces the owner
// used to reach as separate sidebar links (2026-09-22; a third tab, 2026-10-09):
//
//   ROI       MarketingRoiLiveTracker — the live campaign pipeline, money in
//             flight and when each request becomes judgeable.
//   Coverage  MarketingCoverageReportWorkspace — every request's target
//             pharmacies and their realized sales.
//   Managers  MarketingManagerScorecard — one row per person who raised
//             requests: how many, how many were approved, their value, the
//             forecast ROI, and what has actually come back.
//
// All three are unchanged client components rendered exactly "as they are"; this
// file adds only the tab strip. The tabs have DIFFERENT audiences, so each is gated
// individually by the server page and this component renders only the tabs the
// viewer may see (Finance Manager / Financial Advisor get Coverage only). The
// active tab is the only one mounted, so only its data loads — switching tabs is a
// fresh mount, exactly like navigating between the two old pages.
//
// The live tracker is told it sits in the PORTAL (`surface="portal"`), so it does
// not draw a second "ROI Tracker" hero under the page's own header.
//
// The initial tab is read once from ?tab (roi | coverage | managers) so the retired
// /employee-portals/marketing-requests/coverage-report route and the command
// palette can deep-link straight to Coverage. It is NOT written back to the URL on
// switch: MarketingCoverageReportWorkspace owns the query string for its own filter
// state, and a second writer here would fight it.
//
// The strip is real tab markup — a `tablist` owning the `tab`s, each pointing at
// the one `tabpanel` — with the arrow keys moving between them, so a screen reader
// announces "tab, 1 of 3" instead of loose buttons that claim to be tabs. The arrows
// walk the tabs this viewer HAS, never the full order: stepping onto one he cannot
// see would select a tab whose panel renders nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { MarketingCoverageReportWorkspace } from "@/components/marketing-requests/marketing-coverage-report-workspace";
import { MarketingManagerScorecard } from "@/components/marketing-requests/marketing-manager-scorecard";
import { MarketingRoiLiveTracker } from "@/components/marketing-requests/marketing-roi-live-tracker";

type RoiTrackerTab = "roi" | "coverage" | "managers";

const TAB_ORDER: RoiTrackerTab[] = ["roi", "coverage", "managers"];

const TAB_LABEL: Record<RoiTrackerTab, string> = {
  coverage: "Coverage",
  managers: "Managers",
  roi: "ROI",
};

export function RoiTrackerTabs({
  canSeeCoverage,
  canSeeManagers,
  canSeeRoi,
  isSuperAdmin,
  isTerritoryScoped = false,
}: {
  canSeeCoverage: boolean;
  /**
   * Managers — the Manager Scorecard (owner, 2026-10-09): one row per person who raised marketing
   * requests, his approved value, his forecast ROI and what has actually come back. Same audience
   * as the ROI tab, and scoped by the same server-side scope, so a National Sales Manager reads the
   * managers under him and an oversight role reads the company.
   */
  canSeeManagers: boolean;
  canSeeRoi: boolean;
  isSuperAdmin: boolean;
  /**
   * Medical Rep — the one seat that reads the ROI tab through the territory route (own area AND own
   * line since 2026-09-30). Forwarded only so the tracker's EMPTY sentence tells him the truth; it
   * grants and withholds nothing, which stays entirely server-side in roi-report-scope.ts.
   */
  isTerritoryScoped?: boolean;
}) {
  const searchParams = useSearchParams();
  const allowed = (key: RoiTrackerTab): boolean =>
    key === "roi" ? canSeeRoi : key === "coverage" ? canSeeCoverage : canSeeManagers;
  const firstAllowed: RoiTrackerTab = TAB_ORDER.find(allowed) ?? "coverage";
  const [tab, setTab] = useState<RoiTrackerTab>(() => {
    const requested = searchParams.get("tab");
    const match = TAB_ORDER.find((key) => key === requested && allowed(key));
    return match ?? firstAllowed;
  });
  const baseId = useId();

  const visibleTabs = TAB_ORDER.filter(allowed);
  const showTabStrip = visibleTabs.length > 1;
  const activeTab: RoiTrackerTab = allowed(tab) ? tab : firstAllowed;
  const tabId = (key: RoiTrackerTab) => `${baseId}-tab-${key}`;
  const panelId = `${baseId}-panel`;

  function onStripKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge = event.key === "Home" ? visibleTabs[0] : event.key === "End" ? visibleTabs[visibleTabs.length - 1] : null;
    if (!step && !edge) return;
    event.preventDefault();
    const next =
      edge ?? visibleTabs[(visibleTabs.indexOf(activeTab) + step + visibleTabs.length) % visibleTabs.length];
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  }

  const content = (
    <>
      {activeTab === "roi" && canSeeRoi ? (
        <MarketingRoiLiveTracker surface="portal" territoryScoped={isTerritoryScoped} />
      ) : null}
      {activeTab === "coverage" && canSeeCoverage ? (
        <MarketingCoverageReportWorkspace isSuperAdmin={isSuperAdmin} />
      ) : null}
      {activeTab === "managers" && canSeeManagers ? <MarketingManagerScorecard /> : null}
    </>
  );

  return (
    <div className="@container space-y-6">
      {showTabStrip ? (
        <div
          aria-label="ROI Tracker views"
          className={`grid gap-2 border border-slate-200 bg-white p-1.5 ${
            visibleTabs.length > 2 ? "grid-cols-2 @min-[560px]:grid-cols-3" : "grid-cols-2"
          }`}
          onKeyDown={onStripKeyDown}
          role="tablist"
        >
          {visibleTabs.map((key) => (
            <TabButton
              active={activeTab === key}
              controls={panelId}
              id={tabId(key)}
              key={key}
              onClick={() => setTab(key)}
            >
              {TAB_LABEL[key]}
            </TabButton>
          ))}
        </div>
      ) : null}

      {showTabStrip ? (
        <div aria-labelledby={tabId(activeTab)} id={panelId} role="tabpanel">
          {content}
        </div>
      ) : (
        content
      )}
    </div>
  );
}

function TabButton({
  active,
  children,
  controls,
  id,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  controls: string;
  id: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-controls={controls}
      aria-selected={active}
      className={`min-h-10 rounded-sm px-4 text-phx-md font-bold transition md:min-h-9 ${
        active
          ? "bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.25)]"
          : "border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
      }`}
      id={id}
      onClick={onClick}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      {children}
    </button>
  );
}
