// Column widths for the Weekly Sales managers' tables, as percentages of a fixed-layout table.
//
// THE FITS-THE-SCREEN GOLDEN RULE (AGENTS.md §4): every table here is `w-full table-fixed` with each
// column's width declared, so it cannot grow past its container at any screen size. It fits by
// MERGING columns, never by shrinking type or scrolling sideways, and a long name wraps. The widths
// live outside the components so tests/weekly-sales-fits-the-screen.test.ts can hold every set to
// 100% and to the room its content needs at the narrowest desktop.

/** The Field Force league table: the rep (with area and district manager under the name), one column
 * per week, and the period total (with the share under it). */
export function fieldForceLeagueColumns(weekCount: number): { rep: number; week: number; period: number } {
  const period = 16;
  const week = weekCount > 0 ? Math.min(14, 56 / weekCount) : 0;
  return { rep: 100 - period - week * weekCount, week, period };
}

/** The product grid a Field Force rep row opens: product, one column per week, units, value. The same
 * shares as the Medical Rep tab's product table, so the two grids read alike. */
export function fieldForceProductColumns(weekCount: number): {
  product: number;
  week: number;
  units: number;
  value: number;
} {
  const units = 10;
  const value = 14;
  const week = weekCount > 0 ? 52 / weekCount : 0;
  return { product: 100 - units - value - week * weekCount, week, units, value };
}

/** The Distribution tab's Breakdown table. Units is present only when its figures are one product's,
 * and the change column only when there is a month to compare against. */
export function breakdownColumns(
  showUnits: boolean,
  showDelta: boolean,
): { label: number; value: number; units: number; share: number; delta: number } {
  const units = showUnits ? 13 : 0;
  const share = 12;
  const delta = showDelta ? 16 : 0;
  const rest = 100 - units - share - delta;
  return { label: rest / 2, value: rest / 2, units, share, delta };
}

/** The upload completeness matrix: the distributor, then one column per month holding its four week
 * marks. */
export function completenessColumns(monthCount: number): { distributor: number; month: number } {
  const month = monthCount > 0 ? Math.min(23, 69 / monthCount) : 0;
  return { distributor: 100 - month * monthCount, month };
}
