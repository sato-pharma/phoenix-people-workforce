import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// "fix the shit we are seeing now" — the owner, 2026-09-12, with a screenshot of the Closing
// Matrix card: the heading sitting on top of the LINE label, and the description running one
// word per line down the page.
//
// WHAT ACTUALLY HAPPENED, measured on production at 819 px before anything was changed:
//
//   the action wrapper   752 px   `w-full shrink-0 sm:w-auto`
//   the text block         0 px
//   the <h2>               0 px   (56 px tall — "Closing Matrix" stacked letter-pile)
//   the <p>                0 px   (672 px tall)
//   the accent square      0 px   (8 px tall)
//
// Two independent things had to be true at once, and neither is visible in a diff of the other:
//
//   1. `app/globals.css` sets `min-width: 0` on every flex child in the admin shell that does not
//      name a `min-w-*` of its own. That is deliberate and 624 sites rely on it — it is what stops
//      a long cell dragging a page sideways. Its cost is that a text block here has NO min-content
//      floor to stop shrinking at. Without that rule the heading would have stopped at its longest
//      word; with it, it goes to zero.
//   2. The action wrapper carried `shrink-0`, so a toolbar wider than the row took all of it.
//
// THE FIX IS THAT THE ROW WRAPS. The text block gets a 20rem flex-basis — small enough that it
// never forces a wrap by itself, large enough that when the action cannot fit beside it the action
// drops to its own line instead of eating the row. `shrink-0` is gone from the wrapper, because on
// its own line the action has to be able to reflow; it is also what made the toolbar's own
// `flex-wrap` inert (the standing FITS-THE-SCREEN rule says exactly this).
//
// Measured on production, the same page, before → after (main scrollWidth never exceeded
// clientWidth at any width, before or after):
//
//     375 px   309 → 309   identical — below `sm:` none of these classes apply
//     640 px     0 → 558   was broken
//     819 px     0 → 727   was broken — this is his screenshot
//     960 px   100 → 868   was broken
//    1024 px   256 → 872   cramped; now the toolbar takes its own line
//    1100 px   332 → 332   identical
//    1440 px   665 → 665   identical
//
// WHY THIS FILE PINS CLASS NAMES. The defect is a layout one and no Node test can compute a flex
// line break. What it can do is hold the four class decisions that produced those numbers, so a
// later session that removes one is stopped in the required `validate` job rather than shipping a
// header that reads as a letter-pile again on a laptop-width window. The numbers above are the
// evidence; this file is the latch.
// ─────────────────────────────────────────────────────────────────────────────

const DESIGN_SYSTEM = "src/components/admin/admin-design-system.tsx";
const CLOSING_WORKSPACE = "src/components/sales/monthly-closing-workspace.tsx";
const GLOBALS = "app/globals.css";

function read(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** The body of one exported function, so an assertion cannot accidentally match a sibling. */
function functionBody(source: string, name: string, path: string) {
  const start = source.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, `${path} no longer exports ${name} — this test grades a component that moved.`);
  const rest = source.slice(start + 1);
  const next = rest.indexOf("\nexport function ");
  return next >= 0 ? rest.slice(0, next) : rest;
}

export async function runAdminSectionHeaderFitTests() {
  const designSystem = read(DESIGN_SYSTEM);
  const header = functionBody(designSystem, "AdminSectionHeader", DESIGN_SYSTEM);

  // ── 1. The row wraps ────────────────────────────────────────────────────────
  // Without this the action cannot leave the row, and everything below is decoration.
  const rowLine = header.split("\n").find((line) => line.includes("sm:justify-between"));
  assert.ok(rowLine, `${DESIGN_SYSTEM}: AdminSectionHeader's header row is gone — find where the title and the action now sit.`);
  assert.ok(
    rowLine.includes("sm:flex-wrap"),
    `${DESIGN_SYSTEM}: AdminSectionHeader's row must keep sm:flex-wrap. Without it a wide action cannot drop to its own line, and the title beside it is shrunk to 0 px — measured 0 px wide at 640/819/960 on production. Line reads: ${rowLine.trim()}`,
  );

  // ── 2. The text block owns a basis, so it is never the thing that gives way ──
  const textBlockLine = header.split("\n").find((line) => line.includes("sm:basis-"));
  assert.ok(
    textBlockLine,
    `${DESIGN_SYSTEM}: the title/description block in AdminSectionHeader has lost its sm:basis-*. It needs one: the admin shell forces min-width:0 on it (app/globals.css), so with no basis it shrinks to nothing rather than to its longest word.`,
  );
  for (const token of ["sm:grow", "sm:shrink", "sm:basis-80"]) {
    assert.ok(
      textBlockLine.includes(token),
      `${DESIGN_SYSTEM}: the title/description block must carry ${token} — it is 'flex: 1 1 20rem', the smallest width worth reading a heading and a sentence at. Line reads: ${textBlockLine.trim()}`,
    );
  }

  // ── 3. The action wrapper may shrink ────────────────────────────────────────
  const actionLine = header.split("\n").find((line) => line.includes("{action}"));
  assert.ok(actionLine, `${DESIGN_SYSTEM}: AdminSectionHeader no longer renders {action} — this test grades a component that moved.`);
  assert.ok(
    !actionLine.includes("shrink-0"),
    `${DESIGN_SYSTEM}: the action wrapper must NOT carry shrink-0. A pinned wrapper takes the whole header row and leaves the title 0 px (measured on production at 819 px: action 752, title 0), and it makes the toolbar's own flex-wrap inert. Line reads: ${actionLine.trim()}`,
  );

  // ── 4. The accent square is not a shrinkable box ────────────────────────────
  // It is 8x8 with min-width forced to 0 by the shell rule, so it collapsed to 0x8 alongside the
  // heading. Measured on production before the fix; 8 px after.
  const squareLine = header.split("\n").find((line) => line.includes("bg-phx-accent"));
  assert.ok(squareLine, `${DESIGN_SYSTEM}: AdminSectionHeader's accent square is gone.`);
  assert.ok(
    squareLine.includes("shrink-0"),
    `${DESIGN_SYSTEM}: the accent square must keep shrink-0 — the shell forces min-width:0 on it, so without it the square flattens to 0 px wide next to a long title. Line reads: ${squareLine.trim()}`,
  );

  // ── 5. The rule the whole fix is written against still exists ───────────────
  // If this ever goes, flex children get their min-content floor back and the numbers above change.
  // Re-measure before assuming the basis is still the right answer.
  assert.ok(
    read(GLOBALS).includes('.admin-shell :where(.flex, .grid) > *:not([class*="min-w-"])'),
    `${GLOBALS}: the admin-shell min-width:0 rule has moved or gone. It is why a header text block can shrink to 0 rather than to its longest word — re-measure AdminSectionHeader at 640/819/960 before trusting this test's shape.`,
  );

  // ── 6. The toolbar that started this can fold ───────────────────────────────
  // Six controls, ~750 px in one line, in a header row ~727 px wide at his window size.
  const workspace = read(CLOSING_WORKSPACE);
  const toolbarLine = workspace.split("\n").find((line) => line.includes("sm:items-end"));
  assert.ok(toolbarLine, `${CLOSING_WORKSPACE}: the Closing Matrix header toolbar is gone — find where Line / Month / Refresh now live.`);
  assert.ok(
    toolbarLine.includes("sm:flex-wrap"),
    `${CLOSING_WORKSPACE}: the Closing Matrix toolbar must keep sm:flex-wrap. It measures ~752 px on one line and the header row it sits in is 727 px at 819 px wide — without wrapping it overflows its own line. Line reads: ${toolbarLine.trim()}`,
  );

  console.log("  admin section header fit: row wraps, title holds a 20rem basis, action and toolbar both fold");
}
