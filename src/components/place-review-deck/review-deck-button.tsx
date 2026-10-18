"use client";

/**
 * Place checks — the button that opens the one-by-one review, at the top of the Super Admin's board.
 *
 * It opens on the tab he is standing on, with the board's filters as they are (`deckStartOfBoardView`),
 * and `?review=<tab>` opens it straight away — the address the Location integrity page links to.
 *
 * 🔴 A LIGHT BAR, NEVER A DARK BAND: the thick dark block at the top of every page was taken off at the
 * owner's instruction on 2026-09-03 ("remove from all pages this dump block"). The dark ground belongs to
 * the review itself, which is a full-screen dialog over the page, not a band on it.
 */

import { useState } from "react";
import { GalleryHorizontalEnd } from "lucide-react";

import { PlaceReviewDeck, writeReviewParam } from "@/components/place-review-deck/review-deck";
import { CrmButton } from "@/components/phoenix-crm/ui";
import { deckStartOfBoardView, type DeckKind, type DeckTab, type PlaceReviewDeckInput } from "@/lib/place-review-deck/slides";

export function PlaceReviewDeckButton({ input, openOn }: { input: PlaceReviewDeckInput; openOn: DeckTab | null }) {
  const [start, setStart] = useState<{ tab: DeckTab; kind: DeckKind } | null>(() => (openOn ? { tab: openOn, kind: "both" } : null));
  const waiting = input.waiting.reviews.length + input.waiting.venues.length;

  const open = () => {
    const next = deckStartOfBoardView(input.boardView);
    setStart(next);
    writeReviewParam(next.tab);
  };
  const close = () => {
    setStart(null);
    writeReviewParam(null);
  };

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border border-slate-200 border-l-[3px] border-l-orange-500 bg-white px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-black text-slate-900">Review one by one</p>
          <p className="break-words text-xs text-slate-500">
            The photo across the screen, everything to decide on beside it, and the next one slides in once you have decided.
          </p>
        </div>
        <CrmButton className="w-full sm:w-auto" onClick={open} variant="primary">
          <GalleryHorizontalEnd aria-hidden className="h-4 w-4 shrink-0" />
          Review one by one
          {waiting > 0 ? <span className="bg-white/20 px-1.5 py-0.5 text-phx-2xs tabular-nums">{waiting} waiting</span> : null}
        </CrmButton>
      </div>
      {start ? <PlaceReviewDeck input={input} onClose={close} start={start} /> : null}
    </>
  );
}
