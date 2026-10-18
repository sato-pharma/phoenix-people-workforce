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

import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceNoteIndex, ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

/**
 * The tabs, in the order the work is done; `all` is every other tab in this order, each slide once.
 *
 * 🔴 THE BOARD IMPORTS NOTHING FROM THIS FILE BUT TYPES. The Place checks board is also a district
 * manager's portal page, so a value imported from here would put this module in that bundle; the tab
 * WORDS live in the review's own component, which only the Super Admin's page loads.
 */
export const DECK_TABS = ["waiting", "unconfirmed", "integrity", "history", "all"] as const;
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
  unconfirmedPlaces: ReadonlyArray<string>;
  unconfirmedVenues: ReadonlyArray<string>;
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

export function deckSourcesOf(input: PlaceReviewDeckInput, cases: DeckSources["cases"]): DeckSources {
  const reviewIds = (rows: ReadonlyArray<ValidationReviewRow>) => rows.map((row) => row.reviewId);
  const venueIds = (groups: ReadonlyArray<VenueGroup>) => groups.map((group) => group.venue.sharedPlaceId);
  return {
    waitingReviews: reviewIds(input.waiting.reviews),
    waitingVenues: venueIds(input.waiting.venues),
    unconfirmedPlaces: input.unconfirmed.places.map((row) => row.placeId),
    unconfirmedVenues: venueIds(input.unconfirmed.venues),
    historyReviews: reviewIds(input.history.reviews),
    historyVenues: venueIds(input.history.venues),
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
    case "unconfirmed":
      return [
        ...sources.unconfirmedPlaces.map((id): DeckSlide => ({ key: deckSlideKey("place", id), kind: "place", polyclinic: false })),
        ...venues(sources.unconfirmedVenues),
      ];
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
 * The slides of one tab under one switch position, in order. `all` walks the other four tabs in their
 * own order and keeps each slide the first time it appears — a polyclinic held for a decision is in
 * Waiting AND among the buildings in use, and is one slide, not two.
 */
export function buildDeckSlides(tab: DeckTab, kind: DeckKind, sources: DeckSources): DeckSlide[] {
  const tabs: OneTab[] = tab === "all" ? ["waiting", "unconfirmed", "integrity", "history"] : [tab];
  const seen = new Set<string>();
  const slides: DeckSlide[] = [];
  for (const one of tabs) {
    for (const slide of slidesOf(one, sources)) {
      if (seen.has(slide.key) || !kindTakes(kind, slide)) continue;
      seen.add(slide.key);
      slides.push(slide);
    }
  }
  return slides;
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
