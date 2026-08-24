"use client";

import { useState } from "react";

import { DirectTrackingToggle } from "@/components/marketing-requests/direct-tracking-toggle";
import { MarketingRequestSalesView } from "@/components/marketing-requests/marketing-request-sales-view";
import { MarketingSalesEvidencePanel } from "@/components/marketing-requests/marketing-sales-evidence-panel";
import { MarketingRoiExplainPanel } from "@/components/marketing-requests/roi-explain-panel";
import type { MarketingCaseFileLazySection } from "@/lib/marketing-requests/case-file-types";

/* ────────────────────────────────────────────────────────────────────────────
   The Case File's "Go deeper" drill-downs, opened IN PLACE.

   ── WHAT THIS FIXES ──
   Each drill-down used to be a plain full-navigation link straight at a raw JSON API route
   (/api/marketing-requests/<id>/sales-evidence and its three siblings). Pressing one therefore
   navigated the browser OFF the Case File and dumped the route's NextResponse.json(...) into the
   window — a wall of JSON, or a download — with no way back to the request but the back button.
   buildLazySections had always described these as panels "too heavy to run on every open"; the
   intent was press → load on demand → render below the button, and that renderer was never wired.

   Every rich renderer already exists and self-fetches by requestId, so this component only has to
   own the toggle: press a section and its panel mounts inline, below the button; press again and it
   collapses. Toggles are independent — several can be open at once — because a reader comparing the
   ROI explain against the matched rows should not have one close the other.

   ── ONE DELIBERATE OVERLAP ──
   MarketingRequestSalesView ("Matched sales rows") is a superset: it already renders
   DirectTrackingToggle and MarketingRoiExplainPanel inside itself. Opening "Matched sales rows"
   together with either of those two therefore shows that panel in both places. That is accepted:
   the four drill-downs stay distinct and individually cheap (the whole reason they are lazy), each
   is independently collapsible, and the repetition only appears when a reader deliberately opens
   overlapping ones. What is NOT acceptable — and does not happen here — is the same panel rendered
   twice inside a single expander.
   ──────────────────────────────────────────────────────────────────────────── */

/** The self-fetching renderer for one drill-down. Chosen by key; nothing here navigates. */
function GoDeeperPanel({
  panelKey,
  requestId,
  viewSalesBasePath,
}: {
  panelKey: MarketingCaseFileLazySection["key"];
  requestId: string;
  viewSalesBasePath: string;
}) {
  switch (panelKey) {
    case "sales_evidence":
      return <MarketingSalesEvidencePanel requestId={requestId} />;
    case "roi_explain":
      return <MarketingRoiExplainPanel requestId={requestId} />;
    case "view_sales":
      return <MarketingRequestSalesView requestId={requestId} viewSalesBasePath={viewSalesBasePath} />;
    case "direct_tracking":
      return <DirectTrackingToggle requestId={requestId} />;
    default:
      return null;
  }
}

export function MarketingCaseFileGoDeeper({
  requestId,
  sections,
  viewSalesBasePath,
}: {
  requestId: string;
  sections: MarketingCaseFileLazySection[];
  viewSalesBasePath: string;
}) {
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});

  return (
    <div className="mt-2 space-y-1.5">
      {sections.map((section) => {
        // Unavailable stays exactly as it was: a greyed, non-pressable line saying why. A viewer
        // who would only be 403'd on the route is never offered a control that opens it.
        if (!section.available) {
          return (
            <p
              className="border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] font-medium text-slate-400"
              key={section.key}
            >
              {section.label} — {section.reason}
            </p>
          );
        }

        const isOpen = openKeys[section.key] ?? false;
        return (
          <div key={section.key}>
            <button
              aria-expanded={isOpen}
              className="flex w-full items-center justify-between whitespace-nowrap border border-slate-200 bg-white px-3 py-2 text-left text-[12px] font-medium text-slate-700 hover:bg-slate-50"
              onClick={() => setOpenKeys((prev) => ({ ...prev, [section.key]: !isOpen }))}
              type="button"
            >
              <span>{section.label}</span>
              {/* A chevron in place of the old arrow: points right when closed, down when open, so
                  the control reads as expand-in-place rather than navigate-away. */}
              <span aria-hidden className={`ml-2 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}>
                &rsaquo;
              </span>
            </button>
            {isOpen ? (
              <div className="mt-1.5 border-l-2 border-slate-100 pl-3">
                <GoDeeperPanel panelKey={section.key} requestId={requestId} viewSalesBasePath={viewSalesBasePath} />
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
