"use client";

// The decision tabs — Not decided yet · Shortlisted · Sent to manager · Rejected · Hired · All — drawn
// the same way on every screen that lists CVs: the screening page, the candidate pool and the WhatsApp
// Applicants page. The owner, 2026-09-18: "in any screening page you must show did not decide yet ...
// shortlisted ... rejected", so that a new CV is easy to see. The rule that places a CV on a tab is
// candidate-decision-tabs.ts; this file only draws it.
//
// The look is the pool's own Active / Red-flagged strip — the segmented control a screener already
// knows — with two changes the six tabs force. It WRAPS instead of scrolling (the fits-the-screen
// rule: six labels do not fit on one line at phone width, and a horizontal scroll is the bug), and it
// has square edges throughout. Every tab always renders, even at zero, for the reason the pool's
// strip gives: a tab that vanishes when it empties reads as a bug the day it comes back.

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
      className={cn("flex flex-wrap border-l border-t border-phx-line", className)}
      role="group"
    >
      {candidateDecisionTabs.map((tab) => {
        const isActive = tab === active;
        return (
          <button
            aria-pressed={isActive}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 whitespace-nowrap border-b border-r border-phx-line px-3 text-xs font-semibold transition",
              isActive ? "bg-orange-50 text-phx-accent-press" : "bg-white text-slate-600 hover:bg-slate-50",
            )}
            key={tab}
            onClick={() => onSelect(tab)}
            title={candidateDecisionTabDescriptions[tab]}
            type="button"
          >
            {candidateDecisionTabLabels[tab]}
            <span className="tabular-nums opacity-70">{counts[tab]}</span>
          </button>
        );
      })}
    </div>
  );
}
