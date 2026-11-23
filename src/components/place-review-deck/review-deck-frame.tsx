"use client";

/**
 * Place checks — the frame around the one-by-one review's slide: the top bar (title, where he is, the
 * close button, the tabs with what each holds, the Places / Polyclinics switch and the progress line),
 * the whole-screen message a tab with nothing left shows, and the other tabs offered from it.
 *
 * Presentation only. Every value and every handler is the review's own (`review-deck.tsx`), handed in:
 * nothing here holds state, and nothing here decides anything.
 */

import type { ReactNode } from "react";
import { X } from "lucide-react";

import { KIND_LABELS, TAB_LABELS } from "@/components/place-review-deck/review-deck-words";
import { CrmButton } from "@/components/phoenix-crm/ui";
import { DECK_KINDS, DECK_TABS, type DeckKind, type DeckTab } from "@/lib/place-review-deck/slides";
import { cn } from "@/lib/utils";

/** The review's top bar, lifted out of the dialog as it was drawn there: the same markup, fed by the review. */
function DeckHeader({
  chooseKind,
  chooseTab,
  counts,
  kind,
  onClose,
  position,
  progress,
  tab,
  titleId,
  total,
  waitingForCases,
}: {
  chooseKind: (next: DeckKind) => void;
  chooseTab: (next: DeckTab) => void;
  counts: Record<DeckTab, number | null>;
  kind: DeckKind;
  onClose: () => void;
  position: number;
  progress: number;
  tab: DeckTab;
  titleId: string;
  total: number;
  waitingForCases: boolean;
}) {
  return (
    <header className="min-w-0 border-b border-white/10 bg-slate-950">
      <div className="flex min-w-0 items-center gap-3 px-4 pt-3 lg:px-6">
        <div className="min-w-0 flex-1">
          <p className="break-words text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-400">Place checks</p>
          <h2 className="break-words text-base font-black text-white lg:text-lg" id={titleId}>
            Review one by one
          </h2>
        </div>
        {total > 0 && !waitingForCases ? (
          <p className="shrink-0 text-sm font-black tabular-nums text-white">
            {Math.min(position + 1, total)} <span className="font-semibold text-slate-400">of {total}</span>
          </p>
        ) : null}
        <button
          aria-label="Close the review"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-none border border-white/15 text-white transition hover:bg-white/10"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden className="h-5 w-5" />
        </button>
      </div>
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2 px-4 pt-2 lg:px-6">
        <div aria-label="What to review" className="flex min-w-0 flex-wrap" role="tablist">
          {DECK_TABS.map((one) => (
            <button
              key={one}
              aria-selected={tab === one}
              className={cn(
                "-mb-px inline-flex min-h-11 min-w-0 items-center gap-2 rounded-none border-b-2 px-3 py-2 text-left text-sm font-black transition",
                tab === one ? "border-orange-500 text-white" : "border-transparent text-slate-400 hover:text-slate-200",
              )}
              onClick={() => chooseTab(one)}
              role="tab"
              type="button"
            >
              <span className="break-words">{TAB_LABELS[one]}</span>
              <span className={cn("px-1.5 py-0.5 text-phx-2xs tabular-nums", tab === one ? "bg-orange-500 text-white" : "bg-white/10 text-slate-300")}>
                {counts[one] === null ? "·" : counts[one]}
              </span>
            </button>
          ))}
        </div>
        <div aria-label="Places or polyclinics" className="mb-2 inline-flex min-w-0 flex-wrap border border-white/15" role="group">
          {DECK_KINDS.map((one) => (
            <button
              key={one}
              aria-pressed={kind === one}
              className={cn(
                "min-h-9 min-w-0 rounded-none px-3 py-1.5 text-xs font-black transition",
                kind === one ? "bg-white text-slate-950" : "text-slate-300 hover:bg-white/10",
              )}
              onClick={() => chooseKind(one)}
              type="button"
            >
              {KIND_LABELS[one]}
            </button>
          ))}
        </div>
      </div>
      <div aria-hidden className="h-1 bg-white/10">
        <div className="h-full bg-orange-500 transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${progress}%` }} />
      </div>
    </header>
  );
}

/** A whole-screen message: a tab with nothing in it, a tab finished, the cases still being read. */
function DeckMessage({ children, lines, title }: { children?: ReactNode; lines: ReadonlyArray<string>; title: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto px-6 py-10 text-center">
      <p className="max-w-xl break-words text-2xl font-black text-white">{title}</p>
      {lines.map((line) => (
        <p key={line} className="max-w-xl break-words text-sm text-slate-400">
          {line}
        </p>
      ))}
      {children}
    </div>
  );
}

/** The other tabs, each with what it holds, from the panel that closes one. */
function OtherTabs({ counts, current, onChoose }: { counts: Record<DeckTab, number | null>; current: DeckTab; onChoose: (tab: DeckTab) => void }) {
  return (
    <div className="flex min-w-0 flex-wrap justify-center gap-2">
      {DECK_TABS.filter((one) => one !== current && counts[one] !== 0).map((one) => (
        <CrmButton key={one} onClick={() => onChoose(one)} size="sm">
          {TAB_LABELS[one]}
          {counts[one] === null ? "" : ` (${counts[one]})`}
        </CrmButton>
      ))}
    </div>
  );
}

export { DeckHeader, DeckMessage, OtherTabs };
