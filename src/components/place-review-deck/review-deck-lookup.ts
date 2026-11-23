/**
 * Place checks — the one-by-one review's look-up of a slide in the board's CURRENT data: which row a
 * slide stands for, what is still open on it, and which photographs it shows.
 *
 * What each tab holds is taken once, when the review opens; every row is still read from the data the
 * board holds now, so a decided slide shows decided. These three reads are that second half.
 */

import type { IntegrityCase } from "@/lib/phoenix-crm/server/integrity-board";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { ValidatedPlaceRow, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";
import { venueLiveItems, type DeckSlide } from "@/lib/place-review-deck/slides";

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

export { idOf, liveItemsOf, photoPathsOf };
export type { Lookup };
