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
// The initial tab is read once from ?tab (roi | coverage) so the retired
// /employee-portals/marketing-requests/coverage-report route and the command
// palette can deep-link straight to Coverage. It is NOT written back to the URL on
// switch: MarketingCoverageReportWorkspace owns the query string for its own filter
// state, and a second writer here would fight it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

import { MarketingCoverageReportWorkspace } from "@/components/marketing-requests/marketing-coverage-report-workspace";
import { MarketingRoiLiveTracker } from "@/components/marketing-requests/marketing-roi-live-tracker";

type RoiTrackerTab = "roi" | "coverage";

export function RoiTrackerTabs({
  canSeeCoverage,
  canSeeRoi,
  isSuperAdmin,
}: {
  canSeeCoverage: boolean;
  canSeeRoi: boolean;
  isSuperAdmin: boolean;
}) {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<RoiTrackerTab>(() => {
    const requested = searchParams.get("tab");
    if (requested === "coverage" && canSeeCoverage) return "coverage";
    if (requested === "roi" && canSeeRoi) return "roi";
    return canSeeRoi ? "roi" : "coverage";
  });

  const showTabStrip = canSeeRoi && canSeeCoverage;
  const activeTab: RoiTrackerTab = tab === "roi" && canSeeRoi ? "roi" : "coverage";

  return (
    <div className="space-y-6">
      {showTabStrip ? (
        <div className="flex gap-2 rounded-sm border border-slate-200 bg-white p-1.5">
          <TabButton active={activeTab === "roi"} onClick={() => setTab("roi")}>
            ROI
          </TabButton>
          <TabButton active={activeTab === "coverage"} onClick={() => setTab("coverage")}>
            Coverage
          </TabButton>
        </div>
      ) : null}

      {activeTab === "roi" && canSeeRoi ? <MarketingRoiLiveTracker /> : null}
      {activeTab === "coverage" && canSeeCoverage ? (
        <MarketingCoverageReportWorkspace isSuperAdmin={isSuperAdmin} />
      ) : null}
    </div>
  );
}

function TabButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      aria-selected={active}
      className={`min-h-9 rounded-sm px-4 text-phx-md font-bold transition ${
        active
          ? "bg-orange-500 text-white shadow-[0_4px_12px_rgba(249,115,22,0.25)]"
          : "border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50 hover:text-orange-700"
      }`}
      onClick={onClick}
      role="tab"
      type="button"
    >
      {children}
    </button>
  );
}
