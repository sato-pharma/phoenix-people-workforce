/**
 * The Place checks lists and the one-by-one review, as the source-pinning tests read them.
 *
 * Until the split of 23 Nov 2026 each of these five was ONE file — the Super Admin's queue, the places
 * in use, the polyclinics, the customers seated in one, and the review — and about twenty-five tests
 * pinned their rules by reading that file. Each was over the 400-line limit, so its row's evidence and
 * its decision moved into sibling files and the table stayed where it was. A rule did not stop being a
 * rule because the line that carries it moved, so those tests read a list through this helper and keep
 * the sentences they always pinned.
 *
 * 🔴 THE ORDER IS PART OF THE CONTRACT: the parts in the order the one file had them, top to bottom —
 * what is read, then the decision — and the file at the original path last, because the table and the
 * exports were the foot of the one file. (The review's frame follows the review, as its two message
 * panels did.) A test that asks "is this declared before it is drawn" with `indexOf` still gets a true
 * answer.
 *
 * 🔴 A NEW PART OF A LIST IS ADDED HERE, or the rule it carries is pinned by nothing. The last assertion
 * of `tests/phoenix-crm-place-check-lanes.test.ts` refuses a sibling file this list does not name.
 */

import { readFileSync } from "node:fs";

const CRM = "src/components/phoenix-crm";
const DECK = "src/components/place-review-deck";

export type PlaceCheckList = "validation-review-queue" | "validated-place-list" | "shared-place-list" | "shared-place-customers" | "review-deck";

/** Where each list lived as one file, and still lives as the file that exports it. */
export const PLACE_CHECK_LIST_PATHS: Readonly<Record<PlaceCheckList, string>> = {
  "validation-review-queue": `${CRM}/validation-review-queue.tsx`,
  "validated-place-list": `${CRM}/validated-place-list.tsx`,
  "shared-place-list": `${CRM}/shared-place-list.tsx`,
  "shared-place-customers": `${CRM}/shared-place-customers.tsx`,
  "review-deck": `${DECK}/review-deck.tsx`,
};

export const PLACE_CHECK_LIST_FILES: Readonly<Record<PlaceCheckList, ReadonlyArray<string>>> = {
  "validation-review-queue": [`${CRM}/validation-review-queue-evidence.tsx`, `${CRM}/validation-review-queue-decision.tsx`, PLACE_CHECK_LIST_PATHS["validation-review-queue"]],
  "validated-place-list": [`${CRM}/validated-place-list-evidence.tsx`, `${CRM}/validated-place-list-decision.tsx`, PLACE_CHECK_LIST_PATHS["validated-place-list"]],
  "shared-place-list": [`${CRM}/shared-place-list-evidence.tsx`, `${CRM}/shared-place-list-decision.tsx`, PLACE_CHECK_LIST_PATHS["shared-place-list"]],
  "shared-place-customers": [`${CRM}/shared-place-customers-evidence.tsx`, `${CRM}/shared-place-customers-decision.tsx`, PLACE_CHECK_LIST_PATHS["shared-place-customers"]],
  "review-deck": [
    `${DECK}/review-deck-words.ts`,
    `${DECK}/review-deck-browser.ts`,
    `${DECK}/review-deck-lookup.ts`,
    `${DECK}/review-deck-slides.tsx`,
    PLACE_CHECK_LIST_PATHS["review-deck"],
    `${DECK}/review-deck-frame.tsx`,
  ],
};

const rawReader = (path: string): string => readFileSync(path, "utf8");

/** Every file of one list, one after another, each read by the caller's own reader (raw by default). */
export function placeCheckListSource(list: PlaceCheckList, reader: (path: string) => string = rawReader): string {
  return PLACE_CHECK_LIST_FILES[list].map((path) => reader(path)).join("\n");
}

/**
 * The same, asked by path — for a test that walks a list of files and reads each. A path that is one of
 * the five lists' own reads as the whole list; any other path reads as itself.
 */
export function placeCheckListSourceAt(path: string, reader: (path: string) => string = rawReader): string {
  const list = (Object.keys(PLACE_CHECK_LIST_PATHS) as PlaceCheckList[]).find((one) => PLACE_CHECK_LIST_PATHS[one] === path);
  return list ? placeCheckListSource(list, reader) : reader(path);
}
