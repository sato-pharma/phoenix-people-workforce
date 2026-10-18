"use client";

// The decision tabs — Not decided yet · Shortlisted · Sent to manager · Rejected · Hired · All — drawn
// the same way on every screen that lists CVs: the screening page, the candidate pool and the WhatsApp
// Applicants page. The owner, 2026-09-18: "in any screening page you must show did not decide yet ...
// shortlisted ... rejected", so that a new CV is easy to see. The rule that places a CV on a tab is
// candidate-decision-tabs.ts; this file only draws it.
//
// THE LOOK IS THE MODULE'S SEGMENTED CONTROL (2026-10-19 premium sweep): one recessed tray of square
// segments, the chosen one lifted onto white with an orange underline and an orange count chip — the
// same object as `RecruitmentTabBar` in recruitment-premium.tsx, drawn here by hand only because this
// strip is a set of FILTER toggles (`aria-pressed`, a tooltip per pile) rather than a tablist. It
// WRAPS instead of scrolling (the fits-the-screen rule: seven labels do not fit on one line at phone
// width, and a horizontal scroll is the bug), and every corner is square. Every tab always renders,
// even at zero, for the reason the pool's strip gives: a tab that vanishes when it empties reads as a
// bug the day it comes back.

import {
  adminChipDepthClassName,
  adminRecessedDepthClassName,
} from "@/components/admin/admin-design-tokens";
import {
  candidateDecisionTabDescriptions,
  candidateDecisionTabLabels,
  candidateDecisionTabs,
  type CandidateDecisionTab,
} from "@/lib/recruitment/candidate-decision-tabs";
import { cn } from "@/lib/utils";

export function CandidateDecisionTabStrip({
  active,
  counts,
  onSelect,
  className,
}: {
  active: CandidateDecisionTab;
  /** How many CVs each tab holds, over the same filters as the list under it. */
  counts: Record<CandidateDecisionTab, number>;
  onSelect: (tab: CandidateDecisionTab) => void;
  className?: string;
}) {
  return (
    <div
      aria-label="Decision"
      className={cn(`flex flex-wrap gap-1 border border-slate-200 bg-slate-100/80 p-1 ${adminRecessedDepthClassName}`, className)}
      role="group"
    >
      {candidateDecisionTabs.map((tab) => {
        const isActive = tab === active;
        return (
          <button
            aria-pressed={isActive}
            className={cn(
              "relative inline-flex min-h-9 grow items-center justify-center gap-2 whitespace-nowrap px-3 py-1.5 text-xs font-bold transition-colors sm:grow-0",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-400 focus-visible:ring-offset-1",
              isActive
                ? `bg-white text-slate-950 ${adminChipDepthClassName}`
                : "text-slate-600 hover:bg-white/70 hover:text-slate-900",
            )}
            key={tab}
            onClick={() => onSelect(tab)}
            title={candidateDecisionTabDescriptions[tab]}
            type="button"
          >
            {candidateDecisionTabLabels[tab]}
            <span
              className={cn(
                "border px-1.5 text-phx-2xs font-black tabular-nums",
                isActive ? "border-orange-200 bg-orange-50 text-orange-700" : "border-slate-200/80 bg-white/80 text-slate-500",
              )}
            >
              {counts[tab]}
            </span>
            {isActive ? <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 bg-orange-500" /> : null}
          </button>
        );
      })}
    </div>
  );
}
