// The Performance Review's region palette and its first-period floor, split out of
// closing-performance-review.ts into their own dependency-free module for the same reason
// official-lines.ts is: the Performance Review workspace is a CLIENT component and only needs
// `performanceReviewRegionStyle` / `PERFORMANCE_REVIEW_FIRST_PERIOD`, but closing-performance-
// review.ts imports getEmployeeDirectory at its top for the real (server-only) matrix builder,
// which drags employee-photo's `node:crypto` into the browser bundle. Re-exported from
// closing-performance-review.ts unchanged so every existing server caller (the workbook export,
// closing-engine-data.ts, and the tests) keeps importing from where it already does.

/**
 * The first month the by-month series may ever reach back to. Owner's rule: start from July.
 *
 * The closing holds months back to January, and reaching into them is not a longer series — it is a
 * different one. `au.line_area_map` has no history before 2026-07-13, so an earlier month's sales are
 * attributed to today's geography with no as-was map behind them; pre-July months also need
 * per-customer-by-product reconciliation and re-valuation at the current price with targets
 * backfilled before their numbers mean what July's mean. Putting the two regimes side by side and
 * subtracting one from the other produces a growth figure that measures the regime change, not the
 * business — CNS Alex East reads 436,143 / 497,525 / 163,247 / 402,173 / 158,903 / 381,466 across
 * February to July, a sawtooth no sales force produced.
 *
 * July 2026 is the first month closed on today's map, so it is where every series starts. The window
 * fills forward on its own: one column now, two once August closes, up to PERFORMANCE_REVIEW_MONTHS.
 */
export const PERFORMANCE_REVIEW_FIRST_PERIOD = "2026-07";

/**
 * The region palette, in the order the reader expects to meet the regions.
 *
 * It lives here rather than in the workbook builder because the screen and the export must agree:
 * the same region is the same colour on every tab and in the page's own tables.
 */
export const PERFORMANCE_REVIEW_REGIONS: Array<{
  chip: string;
  regionCode: string;
  regionName: string;
  tint: string;
}> = [
  { chip: "FF2F5D8C", regionCode: "CA", regionName: "Cairo", tint: "FFEDF2F9" },
  { chip: "FF3D7A57", regionCode: "GZ", regionName: "Giza", tint: "FFECF4EE" },
  { chip: "FF9C6B32", regionCode: "AB", regionName: "Alex-BHR", tint: "FFFAF2E9" },
  { chip: "FF5F4E8F", regionCode: "D1", regionName: "Delta (1)", tint: "FFF3EFF8" },
  { chip: "FF9C4A63", regionCode: "D2", regionName: "Delta (2)", tint: "FFFCEFF2" },
  { chip: "FF2F7D7A", regionCode: "D3", regionName: "Delta (3)", tint: "FFEAF4F3" },
  { chip: "FFA07A1E", regionCode: "UE", regionName: "Upper Egypt", tint: "FFFDF6E7" },
  { chip: "FF68757E", regionCode: "OT", regionName: "Others", tint: "FFEFF1F3" },
];

const FALLBACK_REGION = { chip: "FF8A8A8A", tint: "FFF4F4F4" };

/**
 * The region family a code belongs to, which is the code itself on every line but one.
 *
 * Anti Infective splits Upper Egypt into two regions, `UE-1` and `UE-2`, while CNS and Pedia carry a
 * single `UE`. Both halves are real regions with their own names and their own managers, so the name
 * column always prints "Upper Egypt 1" and "Upper Egypt 2" in full — the suffix is never hidden. What
 * it must not do is knock the region out of the palette and out of reading order, which is exactly
 * what matching the code exactly did: every Anti Infective Upper Egypt row took the neutral fallback
 * grey and sorted below Others, on the one line where those regions carry the most money.
 *
 * Only a trailing `-<number>` is stripped, so `D1` and `D2` stay the distinct regions they are.
 */
function regionFamilyCode(regionCode: string | null | undefined): string {
  return String(regionCode ?? "")
    .trim()
    .toUpperCase()
    .replace(/-\d+$/, "");
}

/** Palette for a region code. An unknown code keeps its own name and takes the neutral swatch. */
export function performanceReviewRegionStyle(regionCode: string | null | undefined) {
  const code = regionFamilyCode(regionCode);
  return PERFORMANCE_REVIEW_REGIONS.find((row) => row.regionCode === code) ?? FALLBACK_REGION;
}

/** Sort key placing known regions in reading order and anything else after them, alphabetically. */
export function regionOrder(regionCode: string): number {
  const code = regionFamilyCode(regionCode);
  const index = PERFORMANCE_REVIEW_REGIONS.findIndex((row) => row.regionCode === code);
  return index === -1 ? PERFORMANCE_REVIEW_REGIONS.length : index;
}

/**
 * The payload fields that decide whether a review is showing the whole line. Typed structurally so
 * this module stays dependency-free and a CLIENT component can import it — `ClosingPerformanceReview`
 * lives in closing-performance-review.ts, which drags `node:crypto` into the browser bundle.
 */
export type PerformanceReviewScope = {
  areas: ReadonlyArray<unknown>;
  filterOptions?: { areas: ReadonlyArray<unknown>; products: ReadonlyArray<unknown> } | null;
  matrixByProduct: { columns: ReadonlyArray<unknown> };
};

/**
 * Whether what is in hand covers LESS than the whole line.
 *
 * Both counts are already in the payload — the rows that survived the filter, and the pickers' full
 * option lists, which are built from the UNFILTERED matrix on the server for exactly this reason —
 * so this needs no new field and cannot drift from what was actually filtered.
 *
 * A PRODUCT-only filter counts: the areas are all still there, but their figures are no longer the
 * whole line's, so the total they close is not a national one either.
 */
export function reviewShowsLessThanTheWholeLine(review: PerformanceReviewScope): boolean {
  const allAreas = review.filterOptions?.areas.length ?? 0;
  const allProducts = review.filterOptions?.products.length ?? 0;
  return (
    (allAreas > 0 && review.areas.length < allAreas) ||
    (allProducts > 0 && review.matrixByProduct.columns.length < allProducts)
  );
}

/**
 * What a total row that closes the whole grid is CALLED.
 *
 * "National total" is a claim about coverage, and on a filtered view it is simply false — three
 * areas of fifty-eight, or one product of twelve, totalled under a row that says NATIONAL is the
 * number a manager reads as the line's. The export and the screen both ask this, and `scopeLabel`
 * gates on the same predicate, so the masthead's "filtered · 3 of 58 areas" and the row's own wording
 * cannot disagree.
 *
 * Sentence case, as the screen prints it; the workbook upper-cases it at the cell, the way it already
 * upper-cases the line name beside it.
 */
export function reviewTotalRowLabel(review: PerformanceReviewScope): string {
  return reviewShowsLessThanTheWholeLine(review) ? "Filtered total" : "National total";
}
