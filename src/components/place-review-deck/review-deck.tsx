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
 */

import { useCallback, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, CheckCircle2, X } from "lucide-react";

import { IntegrityCaseColumn, IntegrityCaseFooter, IntegrityCaseStage, integrityCaseIsPolyclinic } from "@/components/crm-integrity/integrity-review-slide";
import { ensureDeckCases, loadDeckCases, useDeckCases } from "@/components/place-review-deck/deck-cases";
import { DeckSection, DeckSplitStage, DeckStageEmpty, DeckStagePhoto, DeckSubjectHeader } from "@/components/place-review-deck/deck-parts";
import { PlaceCheckDoneItem, PlaceCheckDoneProvider, type PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import { PlaceCheckNotes } from "@/components/phoenix-crm/place-check-notes";
import { prefetchCrmPhotos } from "@/components/phoenix-crm/photo";
import { SeatedLastColumn, SeatedTimetableEvidence, SeatedWho } from "@/components/phoenix-crm/shared-place-customers";
import { VenueDecision, VenueHeader, venueSignboardText, VenueWhere } from "@/components/phoenix-crm/shared-place-list";
import { CrmSurfaceProvider } from "@/components/phoenix-crm/surface";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { CrmButton, CrmNote, CrmPill, type PillTone } from "@/components/phoenix-crm/ui";
import { PlaceInUseApprove, PlaceInUseEvidence, PlaceInUseRefuse, placeInUsePhotoAlt } from "@/components/phoenix-crm/validated-place-list";
import { ReviewDecision, ReviewEvidence, reviewPhotoAlt } from "@/components/phoenix-crm/validation-review-queue";
import { useDialogA11y } from "@/components/ui/use-dialog-a11y";
import { useHydrated } from "@/hooks/use-hydrated";
import { integrityBoardRow } from "@/lib/crm-integrity/integrity-board-rows";
import { adviseOnBuilding, adviseOnPlaceInUse, adviseOnReview } from "@/lib/phoenix-crm/place-check-advice";
import { placeNoteAdviceLabel, placeNoteSubjectKey, type PlaceNoteAdvice } from "@/lib/phoenix-crm/place-note-rules";
import { TRUSTED_POINT_NO_PHOTO } from "@/lib/phoenix-crm/trusted-point-rules";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";
import type { PlaceNoteIndex, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";
import {
  adviceOnSubject,
  buildDeckSlides,
  DECK_ADVANCE_MS,
  DECK_KINDS,
  DECK_TABS,
  deckAdviceRanker,
  deckArrowStep,
  deckSeatItem,
  deckSlideKey,
  deckSourcesOf,
  deckTabNeedsCases,
  slideIsSettled,
  summarizeDeckOutcomes,
  venueLiveItems,
  type DeckKind,
  type DeckSlide,
  type DeckTab,
  type PlaceReviewDeckInput,
} from "@/lib/place-review-deck/slides";
import { cn } from "@/lib/utils";

const TAB_LABELS: Record<DeckTab, string> = {
  waiting: "Waiting for you",
  unreadable: "Not readable",
  unconfirmed: "Not confirmed",
  newPhoto: "New photo asked",
  integrity: "Integrity cases",
  history: "History",
  all: "All",
};

const KIND_LABELS: Record<DeckKind, string> = { both: "Both", places: "Places", polyclinics: "Polyclinics" };

const OUTCOME_WORDS: Record<PlaceCheckOutcome, string> = {
  approved: "Approved",
  waiting_building: "Approved, waits for the building",
  rejected: "Rejected",
  refused: "Refused",
  restored: "Approved after all",
  kept: "Kept in use",
  settled: "Settled",
  reopened: "Put back to look at again",
  already: "Already decided",
};

type DeckOutcome = { item: string; outcome: PlaceCheckOutcome; slideKey: string };

/** Another modal over the review — the zoomed photo — owns the keyboard while it is open. */
function otherDialogOpen(): boolean {
  return document.querySelectorAll('[role="dialog"][aria-modal="true"]').length > 1;
}

function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.getAttribute("role") === "combobox") return true;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/** `?review=<tab>` kept in step with what is open, so a reload or a shared address opens the same tab. */
export function writeReviewParam(tab: DeckTab | null): void {
  const url = new URL(window.location.href);
  if (tab) url.searchParams.set("review", tab);
  else url.searchParams.delete("review");
  window.history.replaceState(window.history.state, "", url);
}

type Lookup = {
  reviews: ReadonlyMap<string, ValidationReviewRow>;
  places: ReadonlyMap<string, ValidatedPlaceRow>;
  venues: ReadonlyMap<string, VenueGroup>;
  cases: ReadonlyMap<string, IntegrityCase>;
};

function idOf(slide: DeckSlide): string {
  return slide.key.slice(slide.kind.length + 1);
}

/** What the CURRENT data says is still open on a slide — the half of the advance rule the server knows. */
function liveItemsOf(slide: DeckSlide, lookup: Lookup): string[] {
  const id = idOf(slide);
  switch (slide.kind) {
    case "review":
      return lookup.reviews.get(id)?.status === "pending" ? [slide.key] : [];
    case "place":
      return lookup.places.has(id) ? [slide.key] : [];
    case "venue": {
      const group = lookup.venues.get(id);
      return group ? venueLiveItems(group) : [];
    }
    case "case":
      return lookup.cases.has(id) ? [slide.key] : [];
  }
}

function photoPathsOf(slide: DeckSlide | undefined, lookup: Lookup): Array<string | null> {
  if (!slide) return [];
  const id = idOf(slide);
  switch (slide.kind) {
    case "review":
      return [lookup.reviews.get(id)?.photoPath ?? null];
    case "place":
      return [lookup.places.get(id)?.photoPath ?? null];
    case "venue": {
      const venue = lookup.venues.get(id)?.venue;
      return [venue?.photoPath ?? null, venue?.schedulePhotoPath ?? null];
    }
    case "case":
      return [lookup.cases.get(id)?.photoPath ?? null];
  }
}

type SlideView = { stage: ReactNode; column: ReactNode; footer: ReactNode; wideButtons: boolean };

function Comments({ kind, noteIndex, subjectId }: { kind: "place" | "shared_place"; noteIndex: PlaceNoteIndex; subjectId: string }) {
  const key = placeNoteSubjectKey(kind, subjectId);
  return (
    <DeckSection title="Comments">
      <PlaceCheckNotes
        integrity={noteIndex.integrity[key] ?? []}
        mode="company"
        notes={noteIndex.notes[key] ?? []}
        recommendations={noteIndex.recommendations[key] ?? []}
        subjectId={subjectId}
        subjectKind={kind}
      />
    </DeckSection>
  );
}

const ADVICE_TONES: Record<PlaceNoteAdvice, PillTone> = { approve: "good", your_call: "info", new_photo: "warn", reject: "bad" };

/**
 * The by-eye advice, as a coloured tag beside the buttons it is about (owner, 2026-10-19: "Show my
 * advice by the buttons"). It decides nothing: the buttons under it are his.
 */
function AdviceTag({ advice }: { advice: PlaceNoteAdvice | null }) {
  if (!advice) return null;
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-2 text-xs font-black text-slate-500">
      <span className="break-words">Looked at by eye</span>
      <CrmPill tone={ADVICE_TONES[advice]}>{placeNoteAdviceLabel(advice)}</CrmPill>
    </p>
  );
}

function photoWord(kind: "signboard" | "schedule"): string {
  return kind === "schedule" ? "The timetable" : "The signboard";
}

function reviewSlide(row: ValidationReviewRow, noteIndex: PlaceNoteIndex): SlideView {
  const where = row.status === "pending" ? "Held for your decision" : row.status === "approved" ? "Decided · approved" : "Decided · rejected";
  return {
    stage: (
      <DeckStagePhoto
        alt={reviewPhotoAlt(row)}
        caption={`${row.customerName} · captured ${row.createdAtText} · ${row.repName}`}
        label={photoWord(row.photoKind)}
        path={row.photoPath}
      />
    ),
    column: (
      <>
        <DeckSubjectHeader
          eyebrow={where}
          lines={[`${row.repName} · ${row.territory}`, `Captured ${row.createdAtText}`]}
          pills={
            <>
              {row.listType ? <CrmPill>{row.listType}</CrmPill> : null}
              {row.speciality ? <CrmPill>{row.speciality}</CrmPill> : null}
              {row.kind === "added_place" ? <CrmPill tone="info">Another clinic</CrmPill> : null}
              {row.systemStillReading ? <CrmPill tone="info">The system is still reading this sign</CrmPill> : null}
              {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
            </>
          }
          title={row.customerName}
        />
        <DeckSection title="The system's advice">
          <SystemAdvice advice={adviseOnReview(row)} />
        </DeckSection>
        <DeckSection title="Where they stood, and what the photo says">
          <ReviewEvidence row={row} />
        </DeckSection>
        <Comments kind="place" noteIndex={noteIndex} subjectId={row.placeId} />
      </>
    ),
    footer: (
      <div className="space-y-2">
        <AdviceTag advice={adviceOnSubject(noteIndex, "place", row.placeId)} />
        <ReviewDecision row={row} scope="deck-" />
      </div>
    ),
    wideButtons: true,
  };
}

function placeSlide(row: ValidatedPlaceRow, noteIndex: PlaceNoteIndex): SlideView {
  return {
    // A trusted point (owner, 2026-11-10) has no photograph: the stage says so in words.
    stage:
      row.trustedPoint && !row.photoPath ? (
        <DeckStageEmpty
          label="Trusted point"
          lines={["Validated by the Super Admin on the point the reps' own readings agree on."]}
          title={TRUSTED_POINT_NO_PHOTO}
        />
      ) : (
        <DeckStagePhoto
          alt={placeInUsePhotoAlt(row)}
          caption={`${row.customerName} · validated ${row.validatedAtText} · ${row.repName}`}
          label={photoWord(row.photoKind)}
          path={row.photoPath}
        />
      ),
    column: (
      <>
        <DeckSubjectHeader
          eyebrow={row.reviewed ? "In use · looked at before" : "In use · not confirmed"}
          lines={[`${row.repName} · ${row.territory}`, `Validated ${row.validatedAtText}`]}
          pills={
            <>
              {row.listType ? <CrmPill>{row.listType}</CrmPill> : null}
              {row.speciality ? <CrmPill>{row.speciality}</CrmPill> : null}
              {row.reviewed ? null : <CrmPill tone="info">Never looked at</CrmPill>}
              {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
            </>
          }
          title={row.customerName}
        />
        <DeckSection title="The system's advice">
          <SystemAdvice advice={adviseOnPlaceInUse(row)} />
        </DeckSection>
        <DeckSection title="The place they saved">
          <PlaceInUseEvidence row={row} />
        </DeckSection>
        <Comments kind="place" noteIndex={noteIndex} subjectId={row.placeId} />
      </>
    ),
    footer: (
      <div className="space-y-2">
        <AdviceTag advice={adviceOnSubject(noteIndex, "place", row.placeId)} />
        <PlaceInUseApprove row={row} />
        <PlaceInUseRefuse row={row} scope="deck-" />
      </div>
    ),
    wideButtons: true,
  };
}

/** The timetable half of a polyclinic's stage: the photograph, or what is missing, in words. */
function timetableStage(group: VenueGroup): ReactNode {
  const { venue } = group;
  if (venue.timetableExempt) {
    return (
      <DeckStageEmpty
        label="The timetable inside"
        lines={["Its customers are validated by the administrator as an exception.", `Set by ${venue.timetableExempt.byName}, ${venue.timetableExempt.atText}`]}
        title="This building has no timetable."
      />
    );
  }
  if (!venue.schedulePhotoPath) {
    return (
      <DeckStageEmpty
        label="The timetable inside"
        lines={venue.seated > 0 ? ["Every customer seated here is judged against the building's one timetable, and none is on file."] : ["The first customer seated here brings it."]}
        title={venue.seated > 0 ? `No timetable on file, and ${venue.seated === 1 ? "1 customer is" : `${venue.seated} customers are`} seated here.` : "No timetable yet."}
        tone={venue.seated > 0 ? "bad" : "neutral"}
      />
    );
  }
  return (
    <DeckStagePhoto
      alt={`Timetable photo for ${venue.name}`}
      caption={venue.schedulePhotoCapturedAtText ? `${venue.name} · photographed ${venue.schedulePhotoCapturedAtText}` : venue.name}
      label="The timetable inside"
      path={venue.schedulePhotoPath}
    />
  );
}

function venueSlide(group: VenueGroup, noteIndex: PlaceNoteIndex): SlideView {
  const { venue, customers } = group;
  const noTimetable = venue.timetableExempt !== null;
  const read = customers.find((customer) => customer.timetable?.scheduleText)?.timetable?.scheduleText ?? null;
  const waiting = customers.filter((customer) => customer.state === "waiting").length;
  return {
    stage: (
      <DeckSplitStage
        first={
          <DeckStagePhoto
            alt={`Sign photo for ${venue.name}`}
            caption={`${venue.name} · captured ${venue.capturedAtText} · ${venue.repName}`}
            label="The sign on the building"
            path={venue.photoPath}
          />
        }
        second={timetableStage(group)}
      />
    ),
    column: (
      <>
        <header className="min-w-0 space-y-2 border-b border-slate-200 px-5 pb-4 pt-5">
          <p className="break-words text-phx-2xs font-black uppercase tracking-[0.16em] text-orange-600">
            Polyclinic · {venue.status === "held" ? "held for your decision" : venue.status === "retired" ? "rejected" : "in use"}
          </p>
          <VenueHeader mode="company" row={venue} />
        </header>

        {/* Part 1 — the building's own validation, decided on its own. */}
        <DeckSection title="1 · The polyclinic itself">
          {venue.signboard ? (
            <CrmPill tone={venue.signboard.verdict === "match" ? "good" : venue.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
              {venueSignboardText(venue.signboard)}
            </CrmPill>
          ) : (
            <p className="break-words text-xs text-slate-500">The sign has not been read yet.</p>
          )}
          {venue.signboard?.signText ? (
            <p className="break-words text-sm text-slate-700" dir="auto">
              Read on it: {venue.signboard.signText}
            </p>
          ) : null}
          <VenueWhere row={venue} />
          <SystemAdvice advice={adviseOnBuilding(venue)} />
          <div className="space-y-2 border-t border-slate-100 pt-3 [&_button]:w-full">
            <AdviceTag advice={adviceOnSubject(noteIndex, "shared_place", venue.sharedPlaceId)} />
            <PlaceCheckDoneItem item={deckSlideKey("venue", venue.sharedPlaceId)}>
              <VenueDecision row={venue} scope="deck" />
            </PlaceCheckDoneItem>
          </div>
        </DeckSection>
        <Comments kind="shared_place" noteIndex={noteIndex} subjectId={venue.sharedPlaceId} />

        {/* Part 2 — the timetable, approved or rejected per customer, each on his own. */}
        <DeckSection title={`2 · The timetable, per customer (${customers.length}${waiting > 0 ? `, ${waiting} waiting` : ""})`}>
          {read ? (
            <p className="break-words text-sm text-slate-700" dir="auto">
              Read on it: {read}
            </p>
          ) : null}
          {customers.length === 0 ? <p className="break-words text-sm text-slate-500">Nobody is seated in this building yet.</p> : null}
          <ul className="min-w-0 space-y-3">
            {customers.map((customer) => (
              <li
                key={customer.key}
                className={cn(
                  "min-w-0 space-y-3 border bg-white px-4 py-3",
                  customer.state === "waiting" ? "border-orange-300 shadow-[inset_3px_0_0_0_rgb(249_115_22)]" : "border-slate-200",
                )}
              >
                <PlaceCheckDoneItem item={deckSeatItem(customer.key)}>
                  <SeatedWho customer={customer} mode="company" />
                  <SeatedTimetableEvidence customer={customer} mode="company" noTimetable={noTimetable} venueTimetablePath={venue.schedulePhotoPath} />
                  <div className="space-y-2 [&_button]:w-full">
                    <AdviceTag advice={adviceOnSubject(noteIndex, "place", customer.placeId)} />
                    <SeatedLastColumn customer={customer} mode="company" noTimetable={noTimetable} noteIndex={noteIndex} scope="deck" />
                  </div>
                </PlaceCheckDoneItem>
              </li>
            ))}
          </ul>
        </DeckSection>
      </>
    ),
    footer: null,
    wideButtons: false,
  };
}

function caseSlide(entry: IntegrityCase, canSettle: boolean): SlideView {
  const row = integrityBoardRow(entry, "open");
  return {
    stage: <IntegrityCaseStage row={row} />,
    column: <IntegrityCaseColumn row={row} />,
    footer: <IntegrityCaseFooter canSettle={canSettle} row={row} />,
    wideButtons: false,
  };
}

/** A slide whose row has left every list the board holds — answered here, or elsewhere since it opened. */
function answeredSlide(outcome: DeckOutcome | undefined): SlideView {
  const said = outcome ? OUTCOME_WORDS[outcome.outcome] : null;
  return {
    stage: (
      <DeckStageEmpty
        label="Answered"
        lines={[said ? "It has left this list, so there is nothing more to decide on it here." : "It was answered elsewhere, or has aged out of the board, since this review opened."]}
        title={said ? `${said}.` : "No longer on the board."}
      />
    ),
    column: (
      <DeckSection title="This one">
        <p className="break-words text-sm text-slate-700">{said ? `${said} in this review. Press Next for the one after it.` : "Press Next for the one after it."}</p>
      </DeckSection>
    ),
    footer: null,
    wideButtons: false,
  };
}

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
