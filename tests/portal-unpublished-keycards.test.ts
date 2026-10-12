import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  NO_PUBLISHED_CLOSING_NOTE,
  NO_PUBLISHED_CLOSING_SUB,
  WITHHELD_VALUE,
  achievementTone,
  closingSalesSub,
  hasPublishedWindow,
  publishedFigure,
} from "../src/lib/employee-portal/published-window.ts";

/**
 * 🔒 OWNER RULING, 2026-08-13: "a blank keycard is the correct state until a period is published,
 * never a live-but-unclosed number."
 *
 * The DSM / NSM / RM landing keycards read a window that is already gated on publication, so when
 * no Monthly Closing is published for the viewer's line there is no row at all — and the cards used
 * to render that as `EGP 0`, `0%` and a ROSE accent, i.e. a district that sold nothing.
 *
 * It is not hypothetical. On 2026-10-12 the owner unpublished all nine (line × month) closings
 * between 01:05 and 01:11 Cairo to unlock the months for a brick move, and a Pedia Giza district
 * manager reported "everything is showing zero" while his September figures were intact
 * (465,752 EGP against an 828,090 EGP target).
 *
 * This test pins both halves: the helper's arithmetic, and the fact that each of the three
 * dashboards actually routes its money tiles through it.
 */

/** Line + block comments out, so a source assertion cannot be satisfied by a comment ABOUT the call. */
function stripComments(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  return withoutBlocks.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const DASHBOARDS = [
  { file: "src/components/employee-portal/dashboards/dsm-command-center.tsx", label: "District Manager" },
  { file: "src/components/employee-portal/dashboards/nsm-command-center.tsx", label: "National Sales Manager" },
  { file: "src/components/employee-portal/dashboards/rm-command-center.tsx", label: "Regional Manager" },
] as const;

/**
 * The keycard array only.
 *
 * Scoping matters: the RM dashboard also formats money in its "districts needing attention" list,
 * which is driven by a roster that is already empty when nothing is published. A whole-file sweep
 * would have to allow those, and an allowance is what let a BARE tile slip through — the first
 * version of this test asserted only that `publishedFigure(` appeared SOMEWHERE in the file, and
 * unwrapping one of the two DSM money tiles kept it green.
 */
function keycardArraySlice(code: string, file: string): string {
  const start = code.indexOf("const cards");
  assert.ok(start >= 0, `could not find the keycard array in ${file} — has it been renamed?`);
  const end = code.indexOf("\n  ];", start);
  assert.ok(end > start, `could not find the end of the keycard array in ${file}`);
  return code.slice(start, end);
}

export function runPortalUnpublishedKeycardsTests() {
  // ── 1. the signal ──────────────────────────────────────────────────────────
  // windowLabel is salesWindowLabel(activePeriods), and activePeriods is ALREADY filtered to
  // published closings — so null is "nothing is published in your scope", never a format slip.
  assert.equal(hasPublishedWindow("Sep 2026"), true, "a named closing month is a published window");
  assert.equal(hasPublishedWindow("Jul 2026 – Sep 2026"), true, "a multi-month window is published");
  assert.equal(hasPublishedWindow(null), false, "a null window label is NOT published");
  assert.equal(hasPublishedWindow(undefined), false, "a missing window label is NOT published");
  assert.equal(hasPublishedWindow("   "), false, "a blank window label is NOT published");

  // ── 2. a withheld figure is a dash, never a zero ───────────────────────────
  assert.equal(
    publishedFigure(null, () => "EGP 0"),
    WITHHELD_VALUE,
    "WITH NO PUBLISHED CLOSING THE TILE MUST PRINT A DASH. Printing EGP 0 / 0% is the defect a Pedia Giza DM reported on 2026-10-12 — it reads as a district that sold nothing while its real September was 465,752 EGP.",
  );
  assert.equal(
    publishedFigure("Sep 2026", () => "EGP 465.8K"),
    "EGP 465.8K",
    "a published window prints the real figure",
  );
  let rendered = 0;
  publishedFigure(null, () => {
    rendered += 1;
    return "EGP 0";
  });
  assert.equal(rendered, 0, "the formatter must not even run when the figure is withheld");

  // ── 3. the sub-label says WHY, and never implies a closing that does not exist ──
  assert.equal(closingSalesSub("Sep 2026"), "Sep 2026 closing", "a published window names its month");
  assert.equal(
    closingSalesSub(null),
    NO_PUBLISHED_CLOSING_SUB,
    "with nothing published the sub-label must say so, not 'published closing sales' beside a zero",
  );
  assert.ok(
    /no published closing/i.test(NO_PUBLISHED_CLOSING_SUB),
    "the withheld sub-label must name publication as the reason",
  );
  assert.ok(
    !/\d/.test(NO_PUBLISHED_CLOSING_NOTE),
    "the explanatory note carries no number — a withheld state must not quote a figure",
  );

  // ── 4. a withheld achievement tile is NEUTRAL, not red ─────────────────────
  // A rose dash is the same false alarm as the 0% it replaced.
  const withheld = achievementTone(null, 0);
  assert.equal(withheld.valueClass, "text-slate-500", "a withheld achievement tile wears neutral ink");
  assert.ok(
    !/rose|orange|amber|emerald/.test(`${withheld.accent} ${withheld.valueClass}`),
    "A WITHHELD ACHIEVEMENT TILE MUST NOT WEAR A PERFORMANCE COLOUR. Rose beside a dash reads as a collapsed district.",
  );
  // The published bands are unchanged.
  assert.equal(achievementTone("Sep 2026", 104).valueClass, "text-emerald-600", "100%+ stays emerald");
  assert.equal(achievementTone("Sep 2026", 93).valueClass, "text-amber-600", "90-99% stays amber");
  assert.equal(achievementTone("Sep 2026", 75).valueClass, "text-orange-600", "70-89% stays orange");
  assert.equal(achievementTone("Sep 2026", 41).valueClass, "text-rose-600", "under 70% stays rose");
  assert.equal(achievementTone("Sep 2026", 0).valueClass, "text-rose-600", "a PUBLISHED 0% is still a real 0%");

  // ── 5. the three dashboards actually route through it ──────────────────────
  for (const { file, label } of DASHBOARDS) {
    const raw = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const code = stripComments(raw);
    // Guard against the comment stripper eating the declarations it is meant to expose.
    assert.ok(
      code.includes("KeycardGrid") && code.length > raw.length * 0.4,
      `the comment stripper mangled ${file} — fix the stripper, do not relax the assertions below`,
    );
    // EVERY money tile, not merely one of them. Each `value:` expression in the keycard array that
    // formats money must route through publishedFigure(windowLabel, …) — checked per tile, because
    // a file-wide "publishedFigure appears somewhere" assertion stayed GREEN when one of the two
    // DSM money tiles was unwrapped by hand.
    const cards = keycardArraySlice(code, file);
    const tiles = cards.split("value:").slice(1);
    const moneyTiles = tiles.filter((tile) => tile.includes("egpCompact("));
    assert.ok(
      moneyTiles.length >= 2,
      `${label}'s keycard array should hold at least two money tiles — ${file} (found ${moneyTiles.length})`,
    );
    for (const tile of moneyTiles) {
      const expression = tile.slice(0, tile.indexOf("\n"));
      assert.ok(
        expression.includes("publishedFigure(windowLabel"),
        `${label} HAS A KEYCARD MONEY FIGURE THAT IS NOT WITHHELD WHEN NOTHING IS PUBLISHED.\n  tile: value:${expression}\nEvery money tile must route through publishedFigure(windowLabel, () => …), or it prints EGP 0 the moment the closings are unpublished — ${file}`,
      );
    }
    assert.ok(
      code.includes("achievementTone(windowLabel"),
      `${label}'s achievement tile must take its colour from achievementTone(windowLabel, …) — ${file}`,
    );
    assert.ok(
      code.includes("closingSalesSub(windowLabel"),
      `${label}'s sales sub-label must come from closingSalesSub(windowLabel) — ${file}`,
    );
    assert.ok(
      !code.includes('"published closing sales"'),
      `${label} still carries the old "published closing sales" sub-label, which sat under a zero when nothing was published — ${file}`,
    );
    assert.ok(
      code.includes("NO_PUBLISHED_CLOSING_NOTE"),
      `${label} must explain a withheld grid in one line — ${file}`,
    );
  }
}
