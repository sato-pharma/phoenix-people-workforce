/**
 * Column widths for the Business Review tables.
 *
 * Every table on both Business Review surfaces is `table-fixed` with a `<colgroup>`, because the
 * fits-the-screen golden rule forbids a horizontal scroll and the admin shell hands `overflow-x:
 * auto` to any element with a direct `<table>` child whatever its classes say (app/globals.css).
 * A `table-fixed` layout divides the container by these proportions, so the only way the table can
 * out-grow `main` is a group that adds up to more than 100.
 *
 * Several of those tables have a column count the data decides — one per month in the window, one
 * per include product. Tailwind's arbitrary values (`w-[14%]`) are scanned out of the source text,
 * so a computed one would never be generated; those groups set an inline width instead, from this
 * one pure function.
 */

/**
 * Percentages for a table whose first columns are fixed and whose last `fill` columns share
 * whatever is left. Exact by construction: the remainder of the integer division lands on the
 * LAST filled column, so the group always totals exactly 100.
 *
 * @param fixed the leading columns' shares, in percent
 * @param fill  how many equal columns divide the rest (0 when the table has none)
 */
export function columnPercents(fixed: readonly number[], fill = 0): number[] {
  const claimed = fixed.reduce((sum, width) => sum + width, 0);
  if (claimed > 100) {
    throw new Error(`Business Review colgroup claims ${claimed}% before its filled columns`);
  }
  if (fill <= 0) {
    if (claimed !== 100) {
      throw new Error(`Business Review colgroup totals ${claimed}%, not 100%`);
    }
    return [...fixed];
  }
  const rest = 100 - claimed;
  // Two decimals is as fine as a browser needs, and keeps the arithmetic in integers so the
  // remainder is exact rather than a float that lands at 99.99999999999999.
  const each = Math.floor((rest * 100) / fill) / 100;
  const filled = Array.from({ length: fill }, () => each);
  const short = Math.round((rest - each * fill) * 100) / 100;
  filled[fill - 1] = Math.round((each + short) * 100) / 100;
  return [...fixed, ...filled];
}
