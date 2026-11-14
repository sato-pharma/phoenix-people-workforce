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

import { useEffect, useState } from "react";
import { GalleryHorizontalEnd } from "lucide-react";

import { PlaceReviewDeck, writeReviewParam } from "@/components/place-review-deck/review-deck";
import { placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { CrmButton } from "@/components/phoenix-crm/ui";
import { deckStartOfBoardView, type DeckKind, type DeckTab, type PlaceReviewDeckInput } from "@/lib/place-review-deck/slides";

/**
 * Whether the board holds every row the review needs (owner, 2026-11-14, "Load lists on demand"): the page
 * sends only what Needs you draws, so the review asks for the rest (`want`) and opens once it is in.
 */
export type DeckRows = { ready: boolean; want: () => void; error: string | null; retry: () => void };

export function PlaceReviewDeckButton({ input, openOn, rows }: { input: PlaceReviewDeckInput; openOn: DeckTab | null; rows: DeckRows }) {
  const [start, setStart] = useState<{ tab: DeckTab; kind: DeckKind } | null>(() => (openOn ? { tab: openOn, kind: "both" } : null));
  const waiting = input.waiting.reviews.length + input.waiting.venues.length;
  // 🔴 THE REVIEW NEVER OPENS ON PART OF THE BOARD: its Not confirmed slides and its look-up after a decision
  // need every place in use, so it waits for them rather than open on the seated few the page sent.
  const { ready, want } = rows;
  useEffect(() => {
    if (start && !ready) want();
  }, [start, ready, want]);

  const open = () => {
    const next = deckStartOfBoardView(input.boardView);
    setStart(next);
    writeReviewParam(next.tab);
  };
  const close = () => {
    setStart(null);
    writeReviewParam(null);
    // The board's rows draw no saved outcome for what was decided on a slide, so he must not come back to them
    // still offering Approve while the re-read waits for a pause.
    placeCheckReread.flush();
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
        {start && !ready ? (
          <div className="flex w-full min-w-0 flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 basis-60 break-words text-xs font-semibold text-slate-600">
              {rows.error ?? "Reading every place in use — the review opens as soon as they are in."}
            </p>
            {rows.error ? (
              <CrmButton onClick={rows.retry} size="sm">
                Try again
              </CrmButton>
            ) : null}
          </div>
        ) : null}
      </div>
      {start && ready ? <PlaceReviewDeck input={input} onClose={close} start={start} /> : null}
    </>
  );
}
