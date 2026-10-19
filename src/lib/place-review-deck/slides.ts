/**
 * Place checks — the one-by-one review, its slides and the rules that move it (owner, 2026-10-18: "I
 * want to have the picture in a very wide space in the screen and a column on the right having all the
 * data I need … validate from this screen or reject or approve. Then press next … like sliding instead of
 * opening").
 *
 * Pure and screen-free, like `shared-place-groups.ts`, so the review stays a thin shell and every rule
 * here is pinned by `tests/place-review-deck.test.ts`.
 *
 * WHAT A SLIDE IS. One thing he decides on, named by a key — `review:<id>` a place the system held,
 * `place:<id>` a place in use, `venue:<id>` a polyclinic (its building and the customers seated in it,
 * on one screen), `case:<id>` an open location case. A slide holds only its key: its row is looked up
 * in the board's CURRENT data every render, so a decision that moves a row from waiting to decided keeps
 * the slide where it is and simply shows it decided.
 *
 * 🔴 THE LIST IS TAKEN WHEN THE REVIEW OPENS, NOT RECOMPUTED AFTER EVERY DECISION. A held place that is
 * approved leaves the board's waiting set; recomputing the list from it would shift every later slide
 * one to the left under his finger and "12 of 87" would become "12 of 86" showing a different photo.
 */

import { signCouldNotBeRead, standingOfPlaceInUse, timetableCouldNotBeRead } from "@/lib/phoenix-crm/place-check-scorecard";
import { PLACE_NOTE_ADVICE, placeNoteSubjectKey, type PlaceNoteAdvice, type PlaceNoteSubjectKind } from "@/lib/phoenix-crm/place-note-rules";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceNoteIndex, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

/**
 * The tabs, in the order the work is done; `all` is every other tab in this order, each slide once.
 *
 * Not readable (owner, 2026-10-19: "in the review one by one put the unreadable in a separate tab") is
 * every photo the reader could not read — a held place, a place in use, a polyclinic whose sign or
 * timetable could not be read — MOVED out of Waiting and Not confirmed, so each sits in one tab.
 *
 * New photo asked (owner, 2026-10-19: "only what needs you") is the places in use whose rep has already
 * been asked for a new photo. Nothing on them waits on him until it arrives, so they leave Not readable
 * and Not confirmed for a tab of their own, after the work.
 *
 * 🔴 THE BOARD IMPORTS NOTHING FROM THIS FILE BUT TYPES. The Place checks board is also a district
 * manager's portal page, so a value imported from here would put this module in that bundle; the tab
 * WORDS live in the review's own component, which only the Super Admin's page loads.
 */
export const DECK_TABS = ["waiting", "unreadable", "unconfirmed", "newPhoto", "integrity", "history", "all"] as const;
export type DeckTab = (typeof DECK_TABS)[number];

/** Places only, polyclinics only, or both (owner, 2026-10-18: "view polyclinics only, or places only, or both"). */
export const DECK_KINDS = ["both", "places", "polyclinics"] as const;
export type DeckKind = (typeof DECK_KINDS)[number];

export type DeckSlideKind = "review" | "place" | "venue" | "case";

export type DeckSlide = {
  key: string;
  kind: DeckSlideKind;
  /** A building with customers seated in it — or a case filed on one. Everything else is a place. */
  polyclinic: boolean;
};

/** The ids each tab is built from — the board's own filtered sets when the review opened. */
export type DeckSources = {
  waitingReviews: ReadonlyArray<string>;
  waitingVenues: ReadonlyArray<string>;
  /** The photos that could not be read, taken out of the two tabs above and below. */
  unreadableReviews: ReadonlyArray<string>;
  unreadablePlaces: ReadonlyArray<string>;
  unreadableVenues: ReadonlyArray<string>;
  unconfirmedPlaces: ReadonlyArray<string>;
  unconfirmedVenues: ReadonlyArray<string>;
  /** Places in use whose rep has been asked for a new photo — out of every tab above. */
  newPhotoPlaces: ReadonlyArray<string>;
  historyReviews: ReadonlyArray<string>;
  historyVenues: ReadonlyArray<string>;
  /** Null until the cases have been read: they are fetched the first time they are needed, never with the page. */
  cases: ReadonlyArray<{ id: string; polyclinic: boolean }> | null;
};

/**
 * What the board hands the review when the button is pressed.
 *
 * The three tab sets are the board's own FILTERED rows, so the review opens on exactly what he was
 * looking at; `lookup` is every row the board holds, unfiltered, so a slide still finds its row after a
 * decision moved it to a set the filters hide.
 */
export type PlaceReviewDeckInput = {
  /** The board tab he pressed the button on — `deckStartOfBoardView` turns it into the review's tab and switch. */
  boardView: string;
  noteIndex: PlaceNoteIndex;
  waiting: { reviews: ReadonlyArray<ValidationReviewRow>; venues: ReadonlyArray<VenueGroup> };
  unconfirmed: { places: ReadonlyArray<ValidatedPlaceRow>; venues: ReadonlyArray<VenueGroup> };
  history: { reviews: ReadonlyArray<ValidationReviewRow>; venues: ReadonlyArray<VenueGroup> };
  lookup: { reviews: ReadonlyArray<ValidationReviewRow>; places: ReadonlyArray<ValidatedPlaceRow>; venues: ReadonlyArray<VenueGroup> };
};

export function deckSlideKey(kind: DeckSlideKind, id: string): string {
  return `${kind}:${id}`;
}

/** The item a seated customer is answered under — one per customer, inside his building's slide. */
export function deckSeatItem(customerKey: string): string {
  return `seat:${customerKey}`;
}

/** A held place whose photo — its sign, or the timetable it is seated on — could not be read. */
export function reviewIsUnreadable(row: Pick<ValidationReviewRow, "photoKind" | "reason" | "evidence">): boolean {
  if (row.photoKind === "schedule") {
    if (row.reason === "schedule_other_name" || row.reason === "schedule_missing") return false;
    return timetableCouldNotBeRead({ reason: row.evidence.checkReason, heldBecause: row.evidence.heldBecause, problem: row.evidence.problem });
  }
  if (row.reason === "sign_other_name" || row.reason === "sign_no_name") return false;
  return signCouldNotBeRead(row.evidence.signboard);
}

/** A place in use the scorecard counts as Not readable — the same rule, so the two never disagree. */
export function placeIsUnreadable(row: Parameters<typeof standingOfPlaceInUse>[0]): boolean {
  return standingOfPlaceInUse(row) === "notReadable";
}

/** A place in use whose rep has been asked for a new photo of its sign, not yet sent. */
export function placeAwaitsNewPhoto(row: Pick<ValidatedPlaceRow, "signboard">): boolean {
  return row.signboard?.retake === true;
}

/**
 * A polyclinic whose building sign could not be read, or where a customer still waiting or in use has a
 * timetable that could not be read. A rejected or sent-back customer is past the reading.
 */
export function venueIsUnreadable(group: Pick<VenueGroup, "venue" | "customers">): boolean {
  if (signCouldNotBeRead(group.venue.signboard)) return true;
  return group.customers.some((customer) => (customer.state === "waiting" || customer.state === "in_use") && timetableCouldNotBeRead(customer.timetable));
}

export function deckSourcesOf(input: PlaceReviewDeckInput, cases: DeckSources["cases"]): DeckSources {
  const venueId = (group: VenueGroup) => group.venue.sharedPlaceId;
  const unreadableVenues = new Set([...input.waiting.venues, ...input.unconfirmed.venues].filter(venueIsUnreadable).map(venueId));
  const readable = <T>(rows: ReadonlyArray<T>, unreadable: (row: T) => boolean) => rows.filter((row) => !unreadable(row));
  const venuesLeft = (groups: ReadonlyArray<VenueGroup>) => groups.map(venueId).filter((id) => !unreadableVenues.has(id));
  const placesNeedingHim = readable(input.unconfirmed.places, placeAwaitsNewPhoto);
  return {
    waitingReviews: readable(input.waiting.reviews, reviewIsUnreadable).map((row) => row.reviewId),
    waitingVenues: venuesLeft(input.waiting.venues),
    unreadableReviews: input.waiting.reviews.filter(reviewIsUnreadable).map((row) => row.reviewId),
    unreadablePlaces: placesNeedingHim.filter(placeIsUnreadable).map((row) => row.placeId),
    unreadableVenues: [...unreadableVenues],
    unconfirmedPlaces: readable(placesNeedingHim, placeIsUnreadable).map((row) => row.placeId),
    unconfirmedVenues: venuesLeft(input.unconfirmed.venues),
    newPhotoPlaces: input.unconfirmed.places.filter(placeAwaitsNewPhoto).map((row) => row.placeId),
    historyReviews: input.history.reviews.map((row) => row.reviewId),
    historyVenues: input.history.venues.map(venueId),
    cases,
  };
}

type OneTab = Exclude<DeckTab, "all">;

function slidesOf(tab: OneTab, sources: DeckSources): DeckSlide[] {
  const reviews = (ids: ReadonlyArray<string>) => ids.map((id): DeckSlide => ({ key: deckSlideKey("review", id), kind: "review", polyclinic: false }));
  const venues = (ids: ReadonlyArray<string>) => ids.map((id): DeckSlide => ({ key: deckSlideKey("venue", id), kind: "venue", polyclinic: true }));
  switch (tab) {
    case "waiting":
      return [...reviews(sources.waitingReviews), ...venues(sources.waitingVenues)];
    case "unreadable":
      return [
        ...reviews(sources.unreadableReviews),
        ...sources.unreadablePlaces.map((id): DeckSlide => ({ key: deckSlideKey("place", id), kind: "place", polyclinic: false })),
        ...venues(sources.unreadableVenues),
      ];
    case "unconfirmed":
      return [
        ...sources.unconfirmedPlaces.map((id): DeckSlide => ({ key: deckSlideKey("place", id), kind: "place", polyclinic: false })),
        ...venues(sources.unconfirmedVenues),
      ];
    case "newPhoto":
      return sources.newPhotoPlaces.map((id): DeckSlide => ({ key: deckSlideKey("place", id), kind: "place", polyclinic: false }));
    case "integrity":
      return (sources.cases ?? []).map((entry): DeckSlide => ({ key: deckSlideKey("case", entry.id), kind: "case", polyclinic: entry.polyclinic }));
    case "history":
      return [...reviews(sources.historyReviews), ...venues(sources.historyVenues)];
  }
}

function kindTakes(kind: DeckKind, slide: DeckSlide): boolean {
  if (kind === "both") return true;
  return kind === "polyclinics" ? slide.polyclinic : !slide.polyclinic;
}

/**
 * The slides of one tab under one switch position, in order. `all` walks the other tabs in their own
 * order and keeps each slide the first time it appears — a polyclinic held for a decision is in
 * Waiting AND among the buildings in use, and is one slide, not two.
 *
 * `rank` reorders WITHIN each tab, stably: the by-eye "approve" slides first (owner, 2026-10-19), and
 * every slide of equal rank keeps the board's own order. "All" ranks inside each of its tabs, never
 * across them, so the work still runs tab by tab.
 */
export function buildDeckSlides(tab: DeckTab, kind: DeckKind, sources: DeckSources, rank?: (slide: DeckSlide) => number): DeckSlide[] {
  const tabs: OneTab[] = tab === "all" ? DECK_TABS.filter((one): one is OneTab => one !== "all") : [tab];
  const seen = new Set<string>();
  const slides: DeckSlide[] = [];
  for (const one of tabs) {
    const ordered = slidesOf(one, sources);
    const inOrder = rank
      ? ordered
          .map((slide, at) => ({ at, rank: rank(slide), slide }))
          .sort((left, right) => left.rank - right.rank || left.at - right.at)
          .map((entry) => entry.slide)
      : ordered;
    for (const slide of inOrder) {
      if (seen.has(slide.key) || !kindTakes(kind, slide)) continue;
      seen.add(slide.key);
      slides.push(slide);
    }
  }
  return slides;
}

/** The by-eye advice on one subject: the newest of its notes that closes on one (the index is newest first). */
export function adviceOnSubject(noteIndex: PlaceNoteIndex, kind: PlaceNoteSubjectKind, id: string | null): PlaceNoteAdvice | null {
  if (!id) return null;
  for (const note of noteIndex.notes[placeNoteSubjectKey(kind, id)] ?? []) {
    if (note.advice) return note.advice;
  }
  return null;
}

/** Where an advice sorts: approve, your call, new photo, reject — and a slide with none after them all. */
export function deckAdviceRank(advice: PlaceNoteAdvice | null): number {
  return advice ? PLACE_NOTE_ADVICE.indexOf(advice) : PLACE_NOTE_ADVICE.length;
}

/**
 * The advice a slide sorts by. A held place and a place in use carry their place's own; a polyclinic
 * the best of its building's and every seated customer's, so a building with one "approve" customer
 * comes up with the approvals; an integrity case none.
 */
export function deckSlideAdvice(slide: DeckSlide, input: Pick<PlaceReviewDeckInput, "lookup" | "noteIndex">): PlaceNoteAdvice | null {
  const id = slide.key.slice(slide.kind.length + 1);
  switch (slide.kind) {
    case "review":
      return adviceOnSubject(input.noteIndex, "place", input.lookup.reviews.find((row) => row.reviewId === id)?.placeId ?? null);
    case "place":
      return adviceOnSubject(input.noteIndex, "place", id);
    case "venue": {
      const group = input.lookup.venues.find((one) => one.venue.sharedPlaceId === id);
      const all = [adviceOnSubject(input.noteIndex, "shared_place", id), ...(group?.customers ?? []).map((customer) => adviceOnSubject(input.noteIndex, "place", customer.placeId))];
      const best = all.filter((advice): advice is PlaceNoteAdvice => advice !== null).sort((left, right) => deckAdviceRank(left) - deckAdviceRank(right))[0];
      return best ?? null;
    }
    case "case":
      return null;
  }
}

/** The rank `buildDeckSlides` sorts each tab by, taken from the review's input as it was opened. */
export function deckAdviceRanker(input: Pick<PlaceReviewDeckInput, "lookup" | "noteIndex">): (slide: DeckSlide) => number {
  const ranks = new Map<string, number>();
  return (slide) => {
    let rank = ranks.get(slide.key);
    if (rank === undefined) {
      rank = deckAdviceRank(deckSlideAdvice(slide, input));
      ranks.set(slide.key, rank);
    }
    return rank;
  };
}

/** Whether a tab needs the cases read before it can be listed. */
export function deckTabNeedsCases(tab: DeckTab): boolean {
  return tab === "integrity" || tab === "all";
}

/** `?review=<tab>` — the address the integrity board links to. Anything else opens nothing. */
export function parseDeckTab(value: string | null | undefined): DeckTab | null {
  return value && (DECK_TABS as ReadonlyArray<string>).includes(value) ? (value as DeckTab) : null;
}

/**
 * Where the review opens from the board tab he is standing on: the tab that holds the same things, and
 * the switch at the kind that tab shows — Not confirmed is the single clinics, the polyclinic tab the
 * buildings.
 */
export function deckStartOfBoardView(view: string): { tab: DeckTab; kind: DeckKind } {
  switch (view) {
    case "unconfirmed":
      return { tab: "unconfirmed", kind: "places" };
    case "polyclinics":
      return { tab: "all", kind: "polyclinics" };
    case "history":
      return { tab: "history", kind: "both" };
    default:
      return { tab: "waiting", kind: "both" };
  }
}

/**
 * The items on a polyclinic's slide that are still waiting for him: the building itself while it is in
 * use or held (approving it, or keeping it, is the look he came for), and every seated customer the
 * system is still checking. A customer already in use is optional — he MAY reject one, and nothing
 * waits on it — so he is not an item.
 */
export function venueLiveItems(group: Pick<VenueGroup, "venue" | "customers">): string[] {
  const items = group.venue.status === "retired" ? [] : [deckSlideKey("venue", group.venue.sharedPlaceId)];
  for (const customer of group.customers) {
    if (customer.state === "waiting") items.push(deckSeatItem(customer.key));
  }
  return items;
}

/**
 * Whether a slide is answered, so the review may slide on by itself: he has decided at least one thing
 * on it in this session, and nothing on it is still waiting — `live` is what the CURRENT data says is
 * open, `decided` the items he answered here. A held building approved with three customers still
 * waiting stays put until the third is answered.
 */
export function slideIsSettled(input: { live: ReadonlyArray<string>; decided: ReadonlyArray<string> }): boolean {
  if (input.decided.length === 0) return false;
  const decided = new Set(input.decided);
  return input.live.every((item) => decided.has(item));
}

/** How long a decided slide shows its outcome before the next one slides in. */
export const DECK_ADVANCE_MS = 900;

/**
 * What ← and → do: one slide back or on, or nothing. 🔴 NEVER while he is typing a note (the arrows move
 * the caret there), never with a modifier held (that is the browser's or the system's), and never while
 * the zoomed photo is open over the review (its own arrows belong to it). Decisions are never a key:
 * these are live places, and a key pressed by mistake must cost nothing.
 */
export function deckArrowStep(input: { key: string; typing: boolean; modifier: boolean; otherDialogOpen: boolean }): -1 | 0 | 1 {
  if (input.typing || input.modifier || input.otherDialogOpen) return 0;
  if (input.key === "ArrowRight") return 1;
  if (input.key === "ArrowLeft") return -1;
  return 0;
}

/** The decisions of this session, counted for the panel that closes a tab. */
export function summarizeDeckOutcomes(outcomes: Iterable<string>): Array<{ outcome: string; count: number }> {
  const counts = new Map<string, number>();
  for (const outcome of outcomes) counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  return [...counts.entries()].map(([outcome, count]) => ({ outcome, count })).sort((left, right) => right.count - left.count);
}
