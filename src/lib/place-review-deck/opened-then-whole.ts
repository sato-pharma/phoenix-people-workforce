/**
 * Place checks — the one-by-one review that opens before the rest of the board is in (owner, 23 Nov 2026:
 * "Fix speed next").
 *
 * 🔴 THE REVIEW OPENS AT ONCE ON WHAT WAITS. It used to wait for every place in use before it opened at
 * all: 3.1 s on production, for a tab that needs none of them. The page sends the places waiting and not
 * the places in use, so the review opens on the first and takes the second ONCE, when they are all in.
 * These three functions are that rule: which tabs wait, what each tab is built from before and after, and
 * the order a held slide keeps. Pure and screen-free, like `slides.ts`, which they are built on.
 */

import {
  deckAdviceRanker,
  deckSlideKey,
  deckSourcesOf,
  type DeckSlide,
  type DeckSources,
  type DeckTab,
  type PlaceReviewDeckInput,
} from "@/lib/place-review-deck/slides";

/**
 * Whether a tab is built from every place in use and every decision, which the page does not send.
 *
 * Waiting for you is the rows the page sent, and Integrity cases reads for itself; every other tab is
 * listed once the rest is in, and until then shows no count and says it is being read. Not readable waits
 * too, although the held photographs in it are already here: listing them now would move every slide when
 * the places in use arrived between them.
 */
export function deckTabNeedsEveryPlace(tab: DeckTab): boolean {
  return tab !== "waiting" && tab !== "integrity";
}

/**
 * The ids each tab is built from, for a review that may have opened before the rest of the board was in.
 *
 * `opened` is the board as the review opened; `whole` is the board once every place in use was in, taken
 * ONCE, or null until then. Everything held for him stays exactly as it was at opening — the same slides
 * in the same order, whatever was decided or read since — and the other tabs are built from `whole`.
 */
export function deckSourcesOpenedThenWhole(opened: PlaceReviewDeckInput, whole: PlaceReviewDeckInput | null, cases: DeckSources["cases"]): DeckSources {
  const atOpening = deckSourcesOf(opened, cases);
  if (whole === null || whole === opened) return atOpening;
  return { ...deckSourcesOf({ ...whole, waiting: opened.waiting }, cases), waitingReviews: atOpening.waitingReviews, waitingVenues: atOpening.waitingVenues };
}

/**
 * The rank each tab is sorted by, for the same review: a slide that was held at opening keeps the rank it
 * opened with, so Waiting for you never reorders under his finger when the rest of the board arrives.
 */
export function deckRankerOpenedThenWhole(opened: PlaceReviewDeckInput, whole: PlaceReviewDeckInput | null): (slide: DeckSlide) => number {
  const atOpening = deckAdviceRanker(opened);
  if (whole === null || whole === opened) return atOpening;
  const held = new Set([
    ...opened.waiting.reviews.map((row) => deckSlideKey("review", row.reviewId)),
    ...opened.waiting.venues.map((group) => deckSlideKey("venue", group.venue.sharedPlaceId)),
  ]);
  const later = deckAdviceRanker(whole);
  return (slide) => (held.has(slide.key) ? atOpening(slide) : later(slide));
}
