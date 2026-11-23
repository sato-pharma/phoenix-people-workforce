/**
 * Place checks — the one-by-one review's own words: what each tab and each side of the Places /
 * Polyclinics switch is called, and what a saved decision is called on the slide it was made on and in
 * the count that closes a tab.
 *
 * Words only — nothing here draws or decides. The review (`review-deck.tsx`), its top bar
 * (`review-deck-frame.tsx`) and its answered slide (`review-deck-slides.tsx`) all read these, so a tab is
 * never called two things.
 */

import type { PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import type { DeckKind, DeckTab } from "@/lib/place-review-deck/slides";

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
  refused: "Rejected",
  restored: "Approved after all",
  kept: "Approved",
  settled: "Settled",
  reopened: "Put back to look at again",
  already: "Already decided",
};

type DeckOutcome = { item: string; outcome: PlaceCheckOutcome; slideKey: string };

export { KIND_LABELS, OUTCOME_WORDS, TAB_LABELS };
export type { DeckOutcome };
