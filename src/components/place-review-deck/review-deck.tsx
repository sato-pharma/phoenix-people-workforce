"use client";

/**
 * Place checks — the one-by-one review (owner, 2026-10-18: "for the admin to facilitate on him taking
 * the decision … I want to have the picture in a very wide space in the screen and a column on the right
 * having all the data I need … validate from this screen or reject or approve. Then press next … like
 * sliding instead of opening").
 *
 * WHAT HE ASKED FOR, AND WHERE EACH LIVES:
 *   - full screen, opened from a button, sliding on by itself after a decision — the overlay below;
 *   - the Place checks tabs AND the integrity cases, as tabs (Waiting for you · Not readable · Not
 *     confirmed · New photo asked · Integrity cases · History · All) — `DECK_TABS`;
 *   - Places only, Polyclinics only, or Both — the switch beside the tabs;
 *   - a polyclinic split in two on one screen: the building's own validation, approved or rejected on
 *     its own, and the timetable, approved or rejected per customer — the venue slide;
 *   - "very, very premium, polished": a dark stage that gives the photograph the screen, one white
 *     column, one footer, square corners, a short slide between photos (none when the PC asks for less
 *     motion).
 *
 * 🔴 NOT A SECOND DECISION PATH. Every button on a slide is the board's own control, exported from the
 * list it lives in, posting to the route it always posted to. The review adds one thing:
 * `PlaceCheckDoneProvider`, which hears that a control saved, records the outcome and slides on.
 *
 * 🔴 DECISIONS ARE ALWAYS A CLICK, NEVER A KEY. ← and → move between photos; nothing on a keyboard
 * approves, rejects or settles anything, because these are live places and a key pressed by mistake
 * must cost nothing (`deckArrowStep`).
 *
 * 🔴 THE SUPER ADMIN'S ALONE. It is opened only from his own board (`mode="company"`); a district
 * manager's board is never handed the button, and this file is never imported by the board itself —
 * the Super Admin's page passes it in — so it is in none of the portal's bundles.
 *
 * The review's pieces live beside this file since the split of 23 Nov 2026: its words in
 * `review-deck-words.ts`, its questions to the browser in `review-deck-browser.ts`, the look-up of a
 * slide's row in `review-deck-lookup.ts`, what each kind of slide draws in `review-deck-slides.tsx`, and
 * the top bar and the whole-screen messages in `review-deck-frame.tsx`. This file keeps the review itself.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, CheckCircle2 } from "lucide-react";

import { integrityCaseIsPolyclinic } from "@/components/crm-integrity/integrity-review-slide";
import { ensureDeckCases, loadDeckCases, useDeckCases } from "@/components/place-review-deck/deck-cases";
import { otherDialogOpen, typingIn, writeReviewParam } from "@/components/place-review-deck/review-deck-browser";
import { DeckHeader, DeckMessage, OtherTabs } from "@/components/place-review-deck/review-deck-frame";
import { idOf, liveItemsOf, photoPathsOf, type Lookup } from "@/components/place-review-deck/review-deck-lookup";
import { answeredSlide, caseSlide, placeSlide, reviewSlide, venueSlide, type SlideView } from "@/components/place-review-deck/review-deck-slides";
import { KIND_LABELS, OUTCOME_WORDS, TAB_LABELS, type DeckOutcome } from "@/components/place-review-deck/review-deck-words";
import { PlaceCheckDoneProvider, type PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import { prefetchCrmPhotos } from "@/components/phoenix-crm/photo";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { CrmButton, CrmNote } from "@/components/phoenix-crm/ui";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useHydrated } from "@/hooks/use-hydrated";
import {
  buildDeckSlides,
  DECK_ADVANCE_MS,
  DECK_TABS,
  deckAdviceRanker,
  deckArrowStep,
  deckSourcesOf,
  deckTabNeedsCases,
  slideIsSettled,
  summarizeDeckOutcomes,
  type DeckKind,
  type DeckSlide,
  type DeckTab,
  type PlaceReviewDeckInput,
} from "@/lib/place-review-deck/slides";
import { cn } from "@/lib/utils";

export function PlaceReviewDeck({ input, onClose, start }: { input: PlaceReviewDeckInput; onClose: () => void; start: { tab: DeckTab; kind: DeckKind } }) {
  const hydrated = useHydrated();
  const titleId = useId();
  const session = useId();
  // 🔴 WHAT EACH TAB HOLDS IS TAKEN ONCE, WHEN THE REVIEW OPENS — see `slides.ts`. Every row is still
  // looked up in the board's CURRENT data (`input`), so a decided slide shows decided.
  const [frozen] = useState(() => input);
  const cases = useDeckCases(session);
  const [tab, setTab] = useState<DeckTab>(start.tab);
  const [kind, setKind] = useState<DeckKind>(start.kind);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [outcomes, setOutcomes] = useState<ReadonlyMap<string, DeckOutcome>>(() => new Map());
  // The last decision made, and on which slide. Cleared by every manual move, so going Back to an
  // answered slide never slides on again by itself.
  const [lastDecision, setLastDecision] = useState<{ slideKey: string; at: number } | null>(null);

  const close = useCallback(() => {
    // The zoomed photo answers Escape first; the review closes only when nothing is open over it.
    if (otherDialogOpen()) return;
    onClose();
  }, [onClose]);
  const dialogRef = useDialogA11y<HTMLDivElement>({ open: hydrated, onClose: close });

  const needsCases = deckTabNeedsCases(tab);
  useEffect(() => {
    if (needsCases) ensureDeckCases(session);
  }, [needsCases, session]);

  const casesForSlides = useMemo(
    () => (cases.first ? cases.first.map((entry) => ({ id: entry.id, polyclinic: integrityCaseIsPolyclinic(entry) })) : null),
    [cases.first],
  );
  const sources = useMemo(() => deckSourcesOf(frozen, casesForSlides), [frozen, casesForSlides]);
  // The by-eye "approve" ones first in every tab, ranked from the notes as the review opened them.
  const rankSlide = useMemo(() => deckAdviceRanker(frozen), [frozen]);
  const slides = useMemo(() => buildDeckSlides(tab, kind, sources, rankSlide), [tab, kind, sources, rankSlide]);
  const counts = useMemo(() => {
    const result = {} as Record<DeckTab, number | null>;
    for (const one of DECK_TABS) result[one] = deckTabNeedsCases(one) && casesForSlides === null ? null : buildDeckSlides(one, kind, sources).length;
    return result;
  }, [kind, sources, casesForSlides]);
  // "All" waits for the cases rather than listing without them and then shifting every History slide.
  const waitingForCases = needsCases && cases.first === null && cases.status !== "failed";

  const lookup = useMemo<Lookup>(() => {
    const reviews = new Map(input.lookup.reviews.map((row) => [row.reviewId, row] as const));
    const places = new Map(input.lookup.places.map((row) => [row.placeId, row] as const));
    const venues = new Map(input.lookup.venues.map((group) => [group.venue.sharedPlaceId, group] as const));
    const caseMap = new Map(cases.latest.map((entry) => [entry.id, entry] as const));
    return { reviews, places, venues, cases: caseMap };
  }, [input.lookup, cases.latest]);

  const position = Math.min(index, slides.length);
  const current: DeckSlide | undefined = slides[position];
  const finished = !waitingForCases && slides.length > 0 && position >= slides.length;

  const move = useCallback(
    (step: 1 | -1) => {
      setDirection(step);
      setLastDecision(null);
      setIndex((at) => Math.max(0, Math.min(slides.length, Math.min(at, slides.length) + step)));
    },
    [slides.length],
  );

  const chooseTab = (next: DeckTab) => {
    setTab(next);
    setIndex(0);
    setDirection(1);
    setLastDecision(null);
    if (deckTabNeedsCases(next)) ensureDeckCases(session);
    writeReviewParam(next);
  };
  const chooseKind = (next: DeckKind) => {
    setKind(next);
    setIndex(0);
    setDirection(1);
    setLastDecision(null);
  };

  const record = useCallback(
    (item: string, outcome: PlaceCheckOutcome) => {
      if (!current) return;
      const slideKey = current.key;
      setOutcomes((previous) => new Map(previous).set(item, { item, outcome, slideKey }));
      setLastDecision({ slideKey, at: Date.now() });
      // A settled case is read again so its slide shows it answered; the place rows refresh with the page.
      if (current.kind === "case") loadDeckCases(session);
    },
    [current, session],
  );

  // Slide on once the slide in front of him is answered — never on a slide he came Back to.
  const settled = useMemo(() => {
    if (!current) return false;
    const decided = [...outcomes.values()].filter((entry) => entry.slideKey === current.key).map((entry) => entry.item);
    return slideIsSettled({ live: liveItemsOf(current, lookup), decided });
  }, [current, lookup, outcomes]);
  useEffect(() => {
    if (!lastDecision || !current || lastDecision.slideKey !== current.key || !settled) return;
    const timer = window.setTimeout(() => {
      setLastDecision(null);
      setDirection(1);
      setIndex((at) => Math.min(slides.length, at + 1));
    }, DECK_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [current, lastDecision, settled, slides.length]);

  // ← and → between photos; never while typing, never with the zoom open, never a decision.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const step = deckArrowStep({
        key: event.key,
        typing: typingIn(event.target),
        modifier: event.altKey || event.ctrlKey || event.metaKey || event.shiftKey,
        otherDialogOpen: otherDialogOpen(),
      });
      if (step === 0) return;
      event.preventDefault();
      move(step);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  // The next photo is signed while he looks at this one, so it is there when it slides in.
  useEffect(() => {
    prefetchCrmPhotos(photoPathsOf(slides[position + 1], lookup));
  }, [lookup, position, slides]);

  const view = useMemo<SlideView | null>(() => {
    if (!current) return null;
    const id = idOf(current);
    switch (current.kind) {
      case "review": {
        const row = lookup.reviews.get(id);
        return row ? reviewSlide(row, input.noteIndex) : answeredSlide(outcomes.get(current.key));
      }
      case "place": {
        const row = lookup.places.get(id);
        return row ? placeSlide(row, input.noteIndex) : answeredSlide(outcomes.get(current.key));
      }
      case "venue": {
        const group = lookup.venues.get(id);
        return group ? venueSlide(group, input.noteIndex) : answeredSlide(outcomes.get(current.key));
      }
      case "case": {
        const entry = lookup.cases.get(id);
        return entry ? caseSlide(entry, cases.canSettle) : answeredSlide(outcomes.get(current.key));
      }
    }
  }, [cases.canSettle, current, input.noteIndex, lookup, outcomes]);

  const outcomeHere = current ? [...outcomes.values()].filter((entry) => entry.slideKey === current.key) : [];
  const sessionSummary = summarizeDeckOutcomes([...outcomes.values()].map((entry) => OUTCOME_WORDS[entry.outcome]));
  const total = slides.length;
  const progress = total === 0 ? 0 : Math.round((Math.min(position + 1, total) / total) * 100);

  if (!hydrated) return null;

  const body = (() => {
    if (waitingForCases) {
      return <DeckMessage lines={["The open cases are read the first time this tab is opened."]} title="Reading the cases" />;
    }
    if (needsCases && cases.status === "failed" && cases.first === null && tab === "integrity") {
      return (
        <DeckMessage lines={[cases.error ?? "Phoenix could not load this. Try again."]} title="The cases could not be read">
          <CrmButton onClick={() => loadDeckCases(session)} variant="primary">
            Try again
          </CrmButton>
        </DeckMessage>
      );
    }
    if (total === 0) {
      return (
        <DeckMessage lines={[`Nothing ${kind === "both" ? "" : `among the ${KIND_LABELS[kind].toLowerCase()} `}is in ${TAB_LABELS[tab]} with the board's filters as they are.`]} title="Nothing here">
          <OtherTabs counts={counts} current={tab} onChoose={chooseTab} />
        </DeckMessage>
      );
    }
    if (finished || !current || !view) {
      return (
        <DeckMessage lines={[`You have been through all ${total} in ${TAB_LABELS[tab]}.`]} title={`${TAB_LABELS[tab]} — done`}>
          {sessionSummary.length > 0 ? (
            <ul className="flex min-w-0 flex-wrap justify-center gap-2">
              {sessionSummary.map((entry) => (
                <li key={entry.outcome} className="border border-white/15 px-3 py-1.5 text-sm font-black text-white">
                  {entry.count} <span className="font-semibold text-slate-300">{entry.outcome.toLowerCase()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="break-words text-sm text-slate-400">Nothing was decided in this review.</p>
          )}
          <OtherTabs counts={counts} current={tab} onChoose={chooseTab} />
          <div className="flex min-w-0 flex-wrap justify-center gap-2">
            <CrmButton onClick={() => move(-1)}>Back to the last one</CrmButton>
            <CrmButton onClick={onClose} variant="primary">
              Close the review
            </CrmButton>
          </div>
        </DeckMessage>
      );
    }
    const enter = cn(
      "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300",
      direction === 1 ? "motion-safe:slide-in-from-right-8" : "motion-safe:slide-in-from-left-8",
    );
    // Every control on the slide reports what it saved to `record`; a polyclinic's building and each of
    // its customers narrow the item with their own `PlaceCheckDoneItem`.
    return (
      <PlaceCheckDoneProvider item={current.key} key={current.key} onDone={record}>
        <div className="min-h-0 flex-1 overflow-y-auto lg:flex lg:overflow-hidden">
          <section aria-label="The photograph" className={cn("relative h-[55svh] min-h-0 min-w-0 bg-slate-950 lg:h-auto lg:flex-1", enter)}>
            {view.stage}
          </section>
          <aside aria-label="Everything to decide on" className="flex min-w-0 flex-col bg-white text-slate-900 lg:min-h-0 lg:w-[440px] lg:flex-none xl:w-[480px]">
            <div className={cn("min-w-0 lg:min-h-0 lg:flex-1 lg:overflow-y-auto", enter)}>
              {outcomeHere.length > 0 ? (
                <div className="flex min-w-0 items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-emerald-900" role="status">
                  <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
                  <p className="min-w-0 break-words text-sm font-black">
                    {outcomeHere.map((entry) => OUTCOME_WORDS[entry.outcome]).join(" · ")}
                    {settled && lastDecision ? " — the next one is coming" : ""}
                  </p>
                </div>
              ) : null}
              {view.column}
            </div>
            {/* On a wide screen the decision is pinned under the facts, as on the Screening review. On a
                phone it follows the facts and only Back / Next is pinned: a held place's decision is
                about 330 px, and pinned it covered 426 of the 603 px under the photo (measured
                2026-10-19, 375 x 812). */}
            {view.footer ? (
              <div className="min-w-0 border-t border-slate-200 bg-white lg:shadow-[0_-10px_30px_-12px_rgba(15,23,42,0.25)]">
                <div className={cn("min-w-0 px-5 py-3 lg:max-h-[45vh] lg:overflow-y-auto", view.wideButtons ? "[&_button]:w-full" : null)}>{view.footer}</div>
              </div>
            ) : null}
            <nav
              aria-label="Move between photos"
              className="sticky bottom-0 z-10 flex min-w-0 items-center gap-2 border-t border-slate-200 bg-slate-50 px-5 py-2.5 shadow-[0_-10px_30px_-12px_rgba(15,23,42,0.25)] lg:static lg:shadow-none"
            >
              <CrmButton aria-keyshortcuts="ArrowLeft" disabled={position === 0} onClick={() => move(-1)} size="sm">
                <ArrowLeft aria-hidden className="h-4 w-4" />
                Back
              </CrmButton>
              <p className="min-w-0 flex-1 break-words text-center text-xs font-black tabular-nums text-slate-500">
                {position + 1} of {total}
              </p>
              <CrmButton aria-keyshortcuts="ArrowRight" onClick={() => move(1)} size="sm" variant="primary">
                Next
                <ArrowRight aria-hidden className="h-4 w-4" />
              </CrmButton>
            </nav>
          </aside>
        </div>
      </PlaceCheckDoneProvider>
    );
  })();

  return createPortal(
    <CrmSurfaceProvider surface="admin">
      <div aria-labelledby={titleId} aria-modal="true" className="fixed inset-0 z-[200] flex flex-col bg-slate-950 text-white" ref={dialogRef} role="dialog">
        <DeckHeader chooseKind={chooseKind} chooseTab={chooseTab} counts={counts} kind={kind} onClose={onClose} position={position} progress={progress} tab={tab} titleId={titleId} total={total} waitingForCases={waitingForCases} />
        {tab === "integrity" && cases.capped ? (
          <div className="px-4 py-2 lg:px-6">
            <CrmNote tone="warn">There are more open cases than one read can hold: these are the strongest and newest.</CrmNote>
          </div>
        ) : null}
        {/* "All" never presents itself as the whole when the cases could not be read. */}
        {tab === "all" && cases.status === "failed" && cases.first === null ? (
          <div className="px-4 py-2 lg:px-6">
            <CrmNote tone="warn">The open cases could not be read, so All is shown without them. Open Integrity cases to try again.</CrmNote>
          </div>
        ) : null}
        {body}
      </div>
    </CrmSurfaceProvider>,
    document.body,
  );
}

export { writeReviewParam };
