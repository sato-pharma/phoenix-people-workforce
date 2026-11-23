/**
 * The Place checks board, as the source-pinning tests read it.
 *
 * Until the rebuild of 23 Nov 2026 the board was ONE file, `validation-reviews-board.tsx`, and about
 * fifteen tests pinned its rules by reading that file. The rebuild split it: the frame stayed where it
 * was, the state became hooks and each tab its own panel under `place-checks/`. A rule did not stop being
 * a rule because the line that carries it moved, so those tests read the board through this helper and
 * keep the sentences they always pinned.
 *
 * 🔴 THE ORDER IS PART OF THE CONTRACT: the state first (what is computed), then the frame, then the
 * panels (what is drawn) — the order the one file had. A test that asks "is this computed before it is
 * drawn" with `indexOf` still gets a true answer.
 *
 * 🔴 A NEW FILE OF THE BOARD IS ADDED HERE, or the rule it carries is pinned by nothing. The last
 * assertion of `tests/phoenix-crm-place-check-lanes.test.ts` refuses a file under `place-checks/` this
 * list does not name.
 */

import { readFileSync } from "node:fs";

const DIR = "src/components/phoenix-crm/place-checks";

export const PLACE_CHECK_BOARD_SHELL = "src/components/phoenix-crm/validation-reviews-board.tsx";

export const PLACE_CHECK_BOARD_FILES: ReadonlyArray<string> = [
  `${DIR}/board-types.ts`,
  `${DIR}/use-place-check-board.tsx`,
  `${DIR}/use-everything.ts`,
  `${DIR}/use-board-rows.ts`,
  `${DIR}/use-board-lanes.ts`,
  `${DIR}/use-board-address.ts`,
  PLACE_CHECK_BOARD_SHELL,
  `${DIR}/desk-header.tsx`,
  `${DIR}/filter-bar.tsx`,
  `${DIR}/tab-strip.tsx`,
  `${DIR}/ready-lane-bar.tsx`,
  `${DIR}/needs-panel.tsx`,
  `${DIR}/in-use-panel.tsx`,
  `${DIR}/buildings-panel.tsx`,
  `${DIR}/scorecard-panel.tsx`,
  `${DIR}/history-panel.tsx`,
  `${DIR}/paged.tsx`,
  `${DIR}/phone-fold.tsx`,
  `${DIR}/section.tsx`,
];

/** Every file of the board, one after another, each read by the caller's own reader (raw by default). */
export function placeCheckBoardSource(reader: (path: string) => string = (path) => readFileSync(path, "utf8")): string {
  return PLACE_CHECK_BOARD_FILES.map((path) => reader(path)).join("\n");
}
