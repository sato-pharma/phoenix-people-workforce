import assert from "node:assert/strict";

import { spotlightDocumentHtml } from "../src/lib/spotlight/pdf.ts";
import type { SpotlightResult, SpotlightRow } from "../src/lib/spotlight/types.ts";

// Spotlight — the sheet that leaves the building.
//
// This pins the two classes of defect that a PDF does not report. Neither throws, neither shows up
// in a unit test of the arithmetic, and both were live:
//
//   1. A NAME OFF THE PAGE. `.sheet` clips at A4 and the ranking used to print on one sheet however
//      long it was, so a 40-name leaderboard exported 18 names, no footer, and a row sliced in
//      half. The export succeeded. Every assertion below that counts ranks exists for that.
//
//   2. A PAGE-SIZED RASTER PER RULE. Chromium rasterises a CSS gradient or a repeating background
//      into its own full-page layer when printing — measured once at 6.88 MB for a 6-page sheet
//      whose text is a few kilobytes. The ornament is drawn as polylines and the mark is embedded
//      once as a data URI for that reason, and both are easy to "improve" back into a raster.
//
// Plus the house identity rules this document must obey: square edges everywhere, and no filled
// areas beyond the zebra row.

function row(overrides: Partial<SpotlightRow> & { title: string }): SpotlightRow {
  const actualValue = overrides.actualValue ?? 2_000_000;
  const targetValue = overrides.targetValue === undefined ? 1_800_000 : overrides.targetValue;
  return {
    key: overrides.title,
    titleAr: null,
    roleLabel: "Medical Representative",
    territory: "Helwan-Maadi",
    lineName: "CNS",
    hrId: "B-136",
    isVacant: false,
    actualValue,
    targetValue,
    achievement: targetValue === null ? null : (actualValue / targetValue) * 100,
    varianceValue: targetValue === null ? null : actualValue - targetValue,
    targetedMonths: 3,
    activeMonths: 3,
    ...overrides,
  };
}

function result(rows: SpotlightRow[], layout: "leaderboard" | "heroes" | "both" = "leaderboard"): SpotlightResult {
  const actual = rows.reduce((sum, r) => sum + r.actualValue, 0);
  const target = rows.reduce((sum, r) => sum + (r.targetValue ?? 0), 0);
  return {
    selection: {
      window: { kind: "quarter", key: "2026-Q3" },
      subject: "rep",
      filters: {},
      rankBy: "value",
      direction: "top",
      limit: rows.length,
      layout,
    },
    periods: ["2026-06", "2026-07", "2026-08"],
    windowLabel: "Q3 2026",
    headline: "Top Medical Representatives",
    subheadline: "CNS, Pedia and Anti Infective",
    rows,
    totalSubjects: 111,
    shortlistActualValue: actual,
    shortlistTargetValue: target,
    shortlistAchievement: target === 0 ? null : (actual / target) * 100,
    untargetedSubjects: 0,
    generatedAtCairo: "12 September 2026, 03:40",
  };
}

const people = (count: number) =>
  Array.from({ length: count }, (_, i) => row({ title: `Subject Number ${i + 1}`, actualValue: 3_000_000 - i * 10_000 }));

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

/** Rows per sheet, in order, read back out of the rendered markup. */
function rowsPerSheet(html: string): number[] {
  return html
    .split('class="sheet')
    .slice(1)
    .map((sheet) => countOf(sheet, 'class="lb-rank"'));
}

export function runSpotlightSheetDesignTests() {
  // ── A long ranking paginates, and nobody falls off it ──────────────────────────────────────
  const long = spotlightDocumentHtml(result(people(40)));
  const sheets = countOf(long, 'class="sheet');
  assert.ok(sheets > 1, "40 names cannot fit one A4 sheet — the ranking must paginate, not clip");
  for (let rank = 1; rank <= 40; rank += 1) {
    assert.ok(
      long.includes(`class="lb-rank">${String(rank).padStart(2, "0")}<`),
      `rank ${rank} is missing from the document — a clipped sheet loses names with no error at all`,
    );
  }
  for (let i = 1; i <= 40; i += 1) {
    assert.ok(long.includes(`Subject Number ${i}<`), `Subject Number ${i} was dropped from the ranking`);
  }

  // Ranks are continuous and in order across the page break: a continuation sheet restarting at 01
  // would read as a second, smaller ranking.
  const orderedRanks = [...long.matchAll(/class="lb-rank">(\d+)</g)].map((m) => Number(m[1]));
  assert.deepEqual(orderedRanks, Array.from({ length: 40 }, (_, i) => i + 1), "ranks must run 1..40 in order");

  // ── Every sheet says which sheet it is ─────────────────────────────────────────────────────
  assert.equal(countOf(long, "Sheet "), sheets, "every sheet carries its own number — these go out as a stapled pack");
  assert.equal(countOf(long, `of ${sheets}</i>`), sheets, "the total on each sheet is the real page count");

  // ── Pages are balanced, not filled-then-remainder ──────────────────────────────────────────
  const spread = rowsPerSheet(spotlightDocumentHtml(result(people(14))));
  assert.ok(spread.length > 1, "14 uniform names take more than one sheet");
  assert.ok(
    Math.max(...spread) - Math.min(...spread) <= 1,
    `pages must be balanced so the last sheet is not a stub — got ${spread.join("/")}`,
  );
  assert.equal(spread.reduce((a, b) => a + b, 0), 14, "balancing must not add or lose a row");

  // ── Layout switches still produce the pages they promise ───────────────────────────────────
  const both = spotlightDocumentHtml(result(people(3), "both"));
  assert.equal(countOf(both, 'class="sheet'), 4, "both = one leaderboard sheet plus one hero sheet per subject");
  const heroes = spotlightDocumentHtml(result(people(3), "heroes"));
  assert.equal(countOf(heroes, 'class="sheet'), 3, "heroes alone is one sheet per subject, with no leaderboard");
  const alone = spotlightDocumentHtml(result(people(1), "both"));
  assert.equal(countOf(alone, 'class="sheet'), 1, "a single subject needs no leaderboard of one");
  const nobody = spotlightDocumentHtml(result([], "both"));
  assert.equal(countOf(nobody, 'class="sheet'), 1, "an empty selection still prints a sheet that says so");
  assert.ok(nobody.includes("Nobody matched this selection"), "and says it in words, rather than exporting a blank page");

  // ── Nothing on the page may rasterise ──────────────────────────────────────────────────────
  assert.ok(!/gradient\(/.test(long), "a CSS gradient costs Chromium a page-sized raster layer per rule when printing");
  assert.ok(!/repeating-/.test(long), "a repeating background rasterises the same way — the ornament stays vector");
  assert.ok(
    long.includes('src="data:image/svg+xml;base64,'),
    "the mark is embedded ONCE as a base64 data URI; inlining its paths repeats them on every page",
  );
  assert.equal(countOf(long, "<img"), sheets, "one <img> per sheet, all pointing at the same embedded resource");
  assert.ok(!/<img[^>]*src="\/(?!\/)/.test(long), "setContent has no base URL — an /absolute src renders nothing at all");
  assert.ok(long.includes("<polyline"), "the braid and the corner bosses are polylines, not images");

  // ── House identity ─────────────────────────────────────────────────────────────────────────
  assert.ok(long.includes("border-radius: 0"), "square edges everywhere — the house rule has no exception on this sheet");
  const radii = [...long.matchAll(/border-radius:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.deepEqual([...new Set(radii)], ["0"], `no rounded corner may appear on a company document — found ${radii.join(", ")}`);
  assert.ok(long.includes("SATO-DIS-2026-01 v1.0"), "the document identity is Sato Pharma's, on every sheet");

  // ── Colour keeps its meaning ───────────────────────────────────────────────────────────────
  // Green means at-or-above target and red means below, and nothing else on the page is either.
  // A tint WASHED ACROSS THE ROW is what took that meaning away: seven of ten rows filled green
  // reads as decoration. The key is a rule on the rank cell; the only fill is the zebra.
  assert.ok(long.includes("tr.zebra td { background: var(--tint); }"), "the zebra is the one fill the ink rule allows");
  assert.ok(!/tr\.beat td\s*{\s*background/.test(long), "an over-target row is keyed by a rule, never filled with green");
  assert.ok(long.includes("tr.beat td:first-child { border-left-color: var(--green); }"), "over target is keyed green");
  assert.ok(long.includes("tr.miss td:first-child { border-left-color: var(--red); }"), "under target is keyed red");

  // ── Text from the database is escaped ──────────────────────────────────────────────────────
  const injected = spotlightDocumentHtml(result([row({ title: "<b>Ali</b> & Co", territory: "Giza <5>" })]));
  assert.ok(injected.includes("&lt;b&gt;Ali&lt;/b&gt; &amp; Co"), "a name is text, never markup");
  assert.ok(!injected.includes("<b>Ali</b>"), "an unescaped tag from a name would restyle or break the sheet");
}
