// Column widths for the Weekly Sales tables — the managers' portal, the admin shell's dashboard and its
// upload page — as percentages of a fixed-layout table.
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

// Units and stock columns appear only while their figures are one product's (unit-totals.ts). Without
// them the room goes to the name and the value, so each set still totals 100%.

/** A ranked table (By region, By product, By distributor): the name with its value bar beneath, sales
 * value, units, stock and share. */
export function rankColumns(showUnits: boolean): {
  name: number;
  value: number;
  units: number;
  stock: number;
  share: number;
} {
  return showUnits
    ? { name: 34, value: 24, units: 15, stock: 15, share: 12 }
    : { name: 54, value: 34, units: 0, stock: 0, share: 12 };
}

/** The Branches comparison table: the branch with its value bar beneath, its region, sales value, units,
 * stock and share. */
export function branchComparisonColumns(showUnits: boolean): {
  branch: number;
  region: number;
  value: number;
  units: number;
  stock: number;
  share: number;
} {
  return showUnits
    ? { branch: 26, region: 16, value: 20, units: 13, stock: 13, share: 12 }
    : { branch: 38, region: 22, value: 28, units: 0, stock: 0, share: 12 };
}

/** The Week-by-week comparison: month, week (with its gap chips wrapping beneath the week mark), period
 * date, sales value, sales units, stock units and the change against the previous week. */
export function weekComparisonColumns(showUnits: boolean): {
  month: number;
  week: number;
  date: number;
  value: number;
  units: number;
  stock: number;
  delta: number;
} {
  return showUnits
    ? { month: 12, week: 16, date: 14, value: 19, units: 13, stock: 13, delta: 13 }
    : { month: 16, week: 20, date: 18, value: 26, units: 0, stock: 0, delta: 20 };
}

/** The Stock on hand watchlist: the branch with its stock bar beneath, its region and its stock units. */
export function zeroStockColumns(showStock: boolean): { branch: number; region: number; stock: number } {
  return showStock ? { branch: 52, region: 24, stock: 24 } : { branch: 64, region: 36, stock: 0 };
}

// ── The admin shell's Weekly Sales upload page (weekly-upload-workspace.tsx) ──────────────────────
//
// The verification panel sits inside the upload card, which leaves its table 613px at 1024px with the
// sidebar open and 629px at 768px (measured 2026-09-17). It had six columns in an `overflow-x-auto` box;
// File and Col are now one column, the sheet role with its column number beneath it. At 613px that column
// still holds the longest role ("combined") without breaking the word, and Status its widest pill
// ("Missing") on one line. The header text columns take what is left and wrap.

/** The verification panel's column table: the data field, the file with its column number, the header
 * found in the file, the header expected there, and the status. */
export function verifyColumns(): { data: number; file: number; found: number; expected: number; status: number } {
  return { data: 21, file: 16, found: 25, expected: 23, status: 15 };
}

// The rest of the upload page. Every table below is cards under md, so its narrowest table is at 768px or at
// 1024px with the sidebar open. The widths hold a seven-figure unit count ("1,234,567") whole, and the
// longest word of every label and name without breaking it.

/** The Recent weekly uploads table: the select box, the period with its week beneath, the distributor with
 * its status beneath, rows, net units, stock units and the row's actions. Net and stock units hold only a
 * dash (a batch adds different products, unit-totals.ts), so they need room for their headers alone. */
export function uploadHistoryColumns(): {
  select: number;
  period: number;
  distributor: number;
  rows: number;
  net: number;
  stock: number;
  actions: number;
} {
  return { select: 6, period: 22, distributor: 21, rows: 14, net: 11, stock: 11, actions: 15 };
}

/** The items excluded on purpose: item code, item name, rows, net units and stock units. The code column holds a
 * thirteen-digit barcode on one line, since a distributor may key its items that way. */
export function excludedItemColumns(): { code: number; name: number; rows: number; net: number; stock: number } {
  return { code: 22, name: 34, rows: 12, net: 16, stock: 16 };
}

/** The branches excluded on purpose: the branch as the file names it, its branch name, rows, net units and
 * stock units. */
export function excludedBranchColumns(): { branch: number; name: number; rows: number; net: number; stock: number } {
  return { branch: 22, name: 30, rows: 14, net: 17, stock: 17 };
}

/** The file self-check: what the file states, where, the figure the file gives, the figure the import read,
 * and the verdict. */
export function fileSelfCheckColumns(): { label: number; where: number; declared: number; parsed: number; verdict: number } {
  return { label: 24, where: 22, declared: 15, parsed: 15, verdict: 24 };
}

/** The row issues list: the row number, the severity and the message. */
export function rowIssueColumns(): { row: number; severity: number; message: number } {
  return { row: 13, severity: 12, message: 75 };
}

/** The By product, By branch and By region summaries: the name, then sales, return, net and stock units. */
export function uploadSummaryColumns(): { name: number; sales: number; returns: number; net: number; stock: number } {
  return { name: 28, sales: 18, returns: 18, net: 18, stock: 18 };
}

/** The month completeness tracker: the distributor, then one column per week holding its mark. */
export function uploadTrackerColumns(weekCount: number): { distributor: number; week: number } {
  const week = weekCount > 0 ? 48 / weekCount : 0;
  return { distributor: 100 - week * weekCount, week };
}
