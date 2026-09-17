// Column widths for the Weekly Sales tables — the managers' portal and the admin shell's dashboard — as
// percentages of a fixed-layout table.
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

// ── The admin shell's Weekly Sales Dashboard (weekly-dashboard-view-impl.tsx) ──────────────────────
//
// Sized for the narrowest tables, measured on 2026-09-17: the expanded sidebar at 1024px leaves a
// full-width table 640px, 768px (no sidebar) leaves 656px, and from 1536px the ranked tables sit two
// abreast at 556px each. At 556px a money figure ("EGP 98,765,432") still fits its column without breaking
// inside the number and a unit count fits whole; the name columns take what is left and wrap.

/** A ranked table (By region, By product, By distributor): the name with its value bar beneath, sales
 * value, units, stock and share. */
export function rankColumns(): { name: number; value: number; units: number; stock: number; share: number } {
  return { name: 34, value: 24, units: 15, stock: 15, share: 12 };
}

/** The Branches comparison table: the branch with its value bar beneath, its region, sales value, units,
 * stock and share. */
export function branchComparisonColumns(): {
  branch: number;
  region: number;
  value: number;
  units: number;
  stock: number;
  share: number;
} {
  return { branch: 26, region: 16, value: 20, units: 13, stock: 13, share: 12 };
}

/** The Week-by-week comparison: month, week (with its gap chips wrapping beneath the week mark), period
 * date, sales value, sales units, stock units and the change against the previous week. */
export function weekComparisonColumns(): {
  month: number;
  week: number;
  date: number;
  value: number;
  units: number;
  stock: number;
  delta: number;
} {
  return { month: 12, week: 16, date: 14, value: 19, units: 13, stock: 13, delta: 13 };
}

/** The Stock on hand watchlist: the branch with its stock bar beneath, its region and its stock units. */
export function zeroStockColumns(): { branch: number; region: number; stock: number } {
  return { branch: 52, region: 24, stock: 24 };
}
