import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

// ─────────────────────────────────────────────────────────────────────────────
// NOTHING IN THE CLOSING MATRIX IS CUT WITH AN ELLIPSIS — THE HEAD INCLUDED.
//
// The owner's rule: never truncate text with an ellipsis, and where that collides with width,
// wrapping wins (AGENTS.md §4). The area-name cell was brought into line on 2026-09-26 — "the name
// cells no longer carry `truncate` either, so a longer name in future wraps rather than being cut".
// The HEAD was not: the product-name and family-name banners still carried `truncate`, so a long
// name would have been cut to "Tebofortin 120 m…" in the one place that says what a column IS.
//
// It was LATENT, not visible: measured on production on 13 Oct 2026, the longest product name is
// "Tebofortin 120 mg Intens" (24 characters) in a ~450px banner and the longest family is
// "Lacto Advanced" (14) in ~250px, so nothing is being cut today. This is the guarantee for the
// name that does not fit — the same reasoning the area-name fix was shipped with.
//
// Removing the cut is only half of it. The metric row below sticks with a hard-coded `top: 44`,
// which is `h-11` on the row above written as a number: a head that wraps grows and the metric row
// stays 44px down, overlapping the names or floating under them. So the row's real height is
// published as a CSS variable and every sub-header sticks to that, with 44px as the fallback —
// which is exactly the single-line head this grid has always drawn.
// ─────────────────────────────────────────────────────────────────────────────

const TABLE_SOURCE = "src/components/sales/closing-matrix-table.tsx";
const STICKY_VARIABLE = "--phx-closing-subhead-top";

export async function runClosingMatrixHeadNeverEllipsisesTests() {
  const raw = readFileSync(TABLE_SOURCE, "utf8");
  // Comments in this file DISCUSS `truncate` at length. Stripping them first is the difference
  // between asserting about the rendered grid and asserting about its documentation.
  const source = stripComments(raw);

  // ── 1. No cut, anywhere in the grid ───────────────────────────────────────────────────────────
  for (const banned of ["truncate", "text-ellipsis", "line-clamp", "overflow-ellipsis"]) {
    assert.ok(
      !source.includes(banned),
      `${TABLE_SOURCE} must not cut text with "${banned}" — the owner's rule is that nothing is truncated with an ellipsis and wrapping wins (AGENTS.md §4)`,
    );
  }
  assert.ok(
    raw.includes("truncate"),
    `${TABLE_SOURCE} should keep the comments explaining why there is no truncate here — if they are gone, this assertion is the only thing left saying it`,
  );

  // ── 2. The head's two names wrap instead ──────────────────────────────────────────────────────
  const headNames = [...source.matchAll(/<span className="block ([a-z-]+) text-phx-sm font-black/g)].map(
    ([, utility]) => utility,
  );
  assert.equal(
    headNames.length,
    2,
    `expected the product-name and family-name banners in ${TABLE_SOURCE} — found ${headNames.length}. If the head was restructured, re-read it: this suite exists because those two were the last cut cells on the grid.`,
  );
  for (const utility of headNames) {
    assert.equal(
      utility,
      "break-words",
      `a head name must wrap, not be cut — found "${utility}" where break-words is required`,
    );
  }

  // ── 3. The sub-header row follows the head's real height ──────────────────────────────────────
  assert.ok(
    !/\btop:\s*44\b/.test(source),
    `${TABLE_SOURCE} must not hard-code the sub-header offset at 44 — that number is only true while the row above it is one line high, which is the assumption the cut was hiding`,
  );
  assert.ok(
    source.includes(`var(${STICKY_VARIABLE}, 44px)`),
    `${TABLE_SOURCE} must stick the metric row at ${STICKY_VARIABLE}, falling back to 44px — the single-line height it has always had`,
  );
  const stickyTops = [...source.matchAll(/style=\{\{\s*top:\s*SUB_HEADER_TOP\s*\}\}/g)].length;
  assert.ok(
    stickyTops >= 15,
    `every sub-header must take the measured offset — found ${stickyTops}, expected the 10 in MetricHeaders/FamilySubHeaders plus the 5 Grand Total cells`,
  );

  // ── 4. And something actually measures it ─────────────────────────────────────────────────────
  assert.ok(
    source.includes("useLayoutEffect") && source.includes(`setProperty("${STICKY_VARIABLE}"`),
    `${TABLE_SOURCE} must publish the head row's measured height as ${STICKY_VARIABLE} — a variable nothing writes is just the 44px it replaced`,
  );
  assert.ok(
    source.includes("headRowRef") && /<tr ref=\{headRowRef\}>/.test(source),
    `${TABLE_SOURCE} must measure the product-name ROW itself, not a cell inside it`,
  );
  assert.ok(
    !source.includes("setSubHeaderTop") && !source.includes("useState<number>"),
    `the measurement is written to the DOM, never to React state — this grid can be hundreds of rows and must not re-render to measure its own head`,
  );
  assert.ok(
    source.includes("ResizeObserver") && source.includes('typeof ResizeObserver === "undefined"'),
    `${TABLE_SOURCE} must keep watching the head (a column filter changes it) and must degrade where ResizeObserver is absent`,
  );
}
