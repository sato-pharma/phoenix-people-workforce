"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ROI Tracker — the two-tab shell that merges the two marketing-ROI surfaces the
// owner used to reach as separate sidebar links (2026-09-22):
//
//   ROI       MarketingRoiLiveTracker — the live campaign pipeline, money in
//             flight and when each request becomes judgeable.
//   Coverage  MarketingCoverageReportWorkspace — every request's target
//             pharmacies and their realized sales.
//
// Both are unchanged client components rendered exactly "as they are"; this file
// adds only the tab strip. The two tabs have DIFFERENT audiences, so each is gated
// individually by the server page and this component renders only the tabs the
// viewer may see (Finance Manager / Financial Advisor get Coverage only). The
// active tab is the only one mounted, so only its data loads — switching tabs is a
// fresh mount, exactly like navigating between the two old pages.
//
// The live tracker is told it sits in the PORTAL (`surface="portal"`), so it does
// not draw a second "ROI Tracker" hero under the page's own header.
//
// The initial tab is read once from ?tab (roi | coverage) so the retired
// /employee-portals/marketing-requests/coverage-report route and the command
// palette can deep-link straight to Coverage. It is NOT written back to the URL on
// switch: MarketingCoverageReportWorkspace owns the query string for its own filter
// state, and a second writer here would fight it.
//
// The strip is real tab markup — a `tablist` owning two `tab`s, each pointing at
// the one `tabpanel` — with the arrow keys moving between them, so a screen reader
// announces "tab, 1 of 2" instead of two loose buttons that claim to be tabs.
// ─────────────────────────────────────────────────────────────────────────────

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { MarketingCoverageReportWorkspace } from "@/components/marketing-requests/marketing-coverage-report-workspace";
import { MarketingRoiLiveTracker } from "@/components/marketing-requests/marketing-roi-live-tracker";

type RoiTrackerTab = "roi" | "coverage";

const TAB_ORDER: RoiTrackerTab[] = ["roi", "coverage"];

export function RoiTrackerTabs({
  canSeeCoverage,
  canSeeRoi,
  isSuperAdmin,
  isTerritoryScoped = false,
}: {
  canSeeCoverage: boolean;
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
  const [tab, setTab] = useState<RoiTrackerTab>(() => {
    const requested = searchParams.get("tab");
    if (requested === "coverage" && canSeeCoverage) return "coverage";
    if (requested === "roi" && canSeeRoi) return "roi";
    return canSeeRoi ? "roi" : "coverage";
  });
  const baseId = useId();

  const showTabStrip = canSeeRoi && canSeeCoverage;
  const activeTab: RoiTrackerTab = tab === "roi" && canSeeRoi ? "roi" : "coverage";
  const tabId = (key: RoiTrackerTab) => `${baseId}-tab-${key}`;
  const panelId = `${baseId}-panel`;

  function onStripKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const edge = event.key === "Home" ? TAB_ORDER[0] : event.key === "End" ? TAB_ORDER[TAB_ORDER.length - 1] : null;
    if (!step && !edge) return;
    event.preventDefault();
    const next =
      edge ?? TAB_ORDER[(TAB_ORDER.indexOf(activeTab) + step + TAB_ORDER.length) % TAB_ORDER.length];
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
    </>
  );

  return (
    <div className="space-y-6">
      {showTabStrip ? (
        <div
          aria-label="ROI Tracker views"
          className="grid grid-cols-2 gap-2 rounded-sm border border-slate-200 bg-white p-1.5"
          onKeyDown={onStripKeyDown}
          role="tablist"
        >
          {TAB_ORDER.map((key) => (
            <TabButton
              active={activeTab === key}
              controls={panelId}
              id={tabId(key)}
              key={key}
              onClick={() => setTab(key)}
            >
              {key === "roi" ? "ROI" : "Coverage"}
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
