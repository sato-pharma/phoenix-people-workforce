/**
 * Three long files of Place checks, as the source-pinning tests read them.
 *
 * Until 23 Nov 2026 each was ONE file — the server's reviews (`server/validation-reviews.ts`), the bulk
 * bar (`place-check-bulk.tsx`) and the system's advice (`place-check-advice.ts`) — and about thirty tests
 * pinned their rules by reading that file. Each was over the 400-line limit of the module, so its code
 * moved, unchanged, into parts; the file at the original path re-exports what it always exported. A rule
 * did not stop being a rule because the line that carries it moved, so those tests read the file through
 * this helper and keep the sentences they always pinned.
 *
 * 🔴 THE ORDER IS PART OF THE CONTRACT: the reviews' path first (its header and the access re-export
 * were the top of the one file), then its parts in the order the one file had them; the bulk bar's and
 * the advice's parts come before the file at their original path, because what moved out was the top of
 * each. A test that asks "is this declared before it is used" with `indexOf` still gets a true answer.
 *
 * 🔴 A NEW PART IS ADDED HERE, or the rule it carries is pinned by nothing. The last assertion of
 * `tests/phoenix-crm-place-check-lanes.test.ts` refuses a part this list does not name.
 */

import { readFileSync } from "node:fs";

const SERVER = "src/lib/phoenix-crm/server";
const REVIEWS = `${SERVER}/validation-reviews`;

export type PlaceCheckSplitFile = "validation-reviews" | "place-check-bulk" | "place-check-advice";

/** Where each file lived as one, and still lives as the file that exports it. */
export const PLACE_CHECK_SPLIT_PATHS: Readonly<Record<PlaceCheckSplitFile, string>> = {
  "validation-reviews": `${REVIEWS}.ts`,
  "place-check-bulk": "src/components/phoenix-crm/place-check-bulk.tsx",
  "place-check-advice": "src/lib/phoenix-crm/place-check-advice.ts",
};

/** The folder each file's parts live in, and the name every part starts with there ("" = any file). */
export const PLACE_CHECK_SPLIT_PART_HOMES: Readonly<Record<PlaceCheckSplitFile, { folder: string; prefix: string }>> = {
  "validation-reviews": { folder: REVIEWS, prefix: "" },
  "place-check-bulk": { folder: "src/components/phoenix-crm", prefix: "place-check-bulk-" },
  "place-check-advice": { folder: "src/lib/phoenix-crm", prefix: "place-check-advice-" },
};

export const PLACE_CHECK_SPLIT_FILES: Readonly<Record<PlaceCheckSplitFile, ReadonlyArray<string>>> = {
  "validation-reviews": [
    PLACE_CHECK_SPLIT_PATHS["validation-reviews"],
    `${REVIEWS}/shared.ts`,
    `${REVIEWS}/types.ts`,
    `${REVIEWS}/location-checks.ts`,
    `${REVIEWS}/notices.ts`,
    `${REVIEWS}/capture-marks.ts`,
    `${REVIEWS}/queue.ts`,
    `${REVIEWS}/decisions.ts`,
    `${REVIEWS}/decided.ts`,
    `${REVIEWS}/place-in-use-decisions.ts`,
    `${REVIEWS}/reopened.ts`,
  ],
  "place-check-bulk": ["src/components/phoenix-crm/place-check-bulk-picks.tsx", PLACE_CHECK_SPLIT_PATHS["place-check-bulk"]],
  "place-check-advice": ["src/lib/phoenix-crm/place-check-advice-kinds.ts", PLACE_CHECK_SPLIT_PATHS["place-check-advice"]],
};

const rawReader = (path: string): string => readFileSync(path, "utf8");

/** Every file of one split file, one after another, each read by the caller's own reader (raw by default). */
export function placeCheckSplitSource(file: PlaceCheckSplitFile, reader: (path: string) => string = rawReader): string {
  return PLACE_CHECK_SPLIT_FILES[file].map((path) => reader(path)).join("\n");
}

/**
 * The same, asked by path — for a test that walks a list of files and reads each. One of the three
 * original paths reads as the whole file; any other path reads as itself.
 */
export function placeCheckSplitSourceAt(path: string, reader: (path: string) => string = rawReader): string {
  const file = (Object.keys(PLACE_CHECK_SPLIT_PATHS) as PlaceCheckSplitFile[]).find((one) => PLACE_CHECK_SPLIT_PATHS[one] === path);
  return file ? placeCheckSplitSource(file, reader) : reader(path);
}
