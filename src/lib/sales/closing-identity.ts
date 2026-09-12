/**
 * The premium closing workbook's identity, as CSS.
 *
 * Owner, 2026-09-12: "brand the front end closing as the premium xlsx sato identity". The premium
 * Monthly Closing workbook already wears an approved executive look (he approved it on 2026-09-08
 * and asked for it to become the standing identity of that file); this module is the same palette
 * spelled the way a browser can read it, so the screen a manager opens and the workbook he
 * downloads are visibly one document.
 *
 * WHY THE VALUES ARE COPIED AND NOT IMPORTED. `closing-executive-look.ts` is a server module: it
 * takes a JSZip, carries a base64 emblem, and rewrites OOXML. Importing `EXECUTIVE_PALETTE` from a
 * "use client" component would pull all of that into the browser bundle for eleven strings. The
 * copy is instead pinned by `tests/closing-screen-identity.test.ts`, which asserts every value here
 * equals the workbook's own, role for role — so the two can never drift, and the drift is caught in
 * the required CI `validate` job rather than by somebody noticing the screen looks different.
 *
 * Workbook values carry an `FF` alpha prefix (`FF0A1F33`); CSS does not. That prefix is the only
 * difference the test allows.
 */
export const CLOSING_IDENTITY = {
  /** Deep navy. The masthead, the grand-total rows, and the rules that separate the bands. */
  primaryNavy: "#0A1F33",
  /** Table headers and the second-level bands. */
  secondaryNavy: "#103A5C",
  /** Links, KPI figures, the accent on a header row — and the Target axis. */
  corporateBlue: "#0B78B7",
  /** KPI panel ground; the tint under a measured column. */
  lightBlue: "#E8F2F8",
  /** Page ground under a band; the zebra's lighter half. */
  veryLight: "#F3F8FC",
  /** Body type. */
  mainText: "#16324A",
  /** Captions, footnotes, and a figure that is derived rather than measured. */
  mutedText: "#6B8296",
  /**
   * The one deliberately loud colour, and on screen as in the workbook it is spent on exactly ONE
   * control: Export Premium XLSX. The workbook spends it on the Rep Card's Export PDF for the same
   * reason — if a second thing wears it, neither is the loud one any more. Do not put it on a
   * header, a total, or the frozen black Export XLSX button.
   */
  accentCyan: "#00A6D6",
  /** The incomplete-month strip. */
  warningFill: "#FFF3D6",
  warningText: "#8A5A00",
  white: "#FFFFFF",
} as const;

/**
 * The hairline between cells.
 *
 * The workbook rules its bands in `primaryNavy`, which at 1px on every cell of a 42-column grid is
 * a cage rather than a table — print rules and screen rules are not the same weight. This is the
 * approved `mutedText` at the alpha a hairline needs, so it is still one of the seven colours and
 * not an invented grey.
 */
export const CLOSING_GRID_LINE = "rgba(107, 130, 150, 0.28)";

/**
 * Two more grounds, so every SPECIAL column on the closing matrix is identifiable by colour.
 *
 * Owner, 2026-09-12: "add other colours for special columns for identification". The grid has five
 * kinds of column and only three grounds were separating them, so "of which Office" and "Ach %"
 * were reading as ordinary sales. These are the two that were missing.
 *
 * THEY ARE NOT NEW COLOURS. Each is an identity colour at low alpha — exactly how `lightBlue` and
 * `veryLight` relate to `corporateBlue` in the workbook itself — so the page still holds the seven
 * approved hues and nothing else. `accentCyan` is deliberately NOT among them: it is spent on one
 * control (see its note above), and a column wearing it would take that away.
 *
 * ALPHA, NOT A FLAT HEX, ON PURPOSE: these grounds sit over a zebra band on some rows and over a
 * region subtotal's light blue on others, and a flat hex would erase whichever it landed on. A tint
 * composites, so the column stays identifiable inside every row it crosses.
 */
export const CLOSING_COLUMN_TINT = {
  /** "of which Office" — secondaryNavy, cooled down. A component of the sale beside it. */
  office: "rgba(16, 58, 92, 0.10)",
  /** "Ach %" — corporateBlue, the verdict the row exists to produce. */
  achievement: "rgba(11, 120, 183, 0.13)",
} as const;

/**
 * The workbook's typeface, with the stack a browser needs behind it.
 *
 * Every font in `closing-executive-look.ts` is `Segoe UI`. It ships with Windows, which is what
 * every reader of this page is on, and the fallbacks only matter for the screenshot pipeline.
 */
export const CLOSING_FONT_STACK =
  '"Segoe UI", "Segoe UI Variable Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif';
