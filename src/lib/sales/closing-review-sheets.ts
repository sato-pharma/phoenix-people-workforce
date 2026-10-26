// The Performance Review, as sheets in the premium workbook.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// WHY ONLY THREE. The review already produces a workbook of its own with `Rep Ranking` and
// `Family Performance` on it, and the premium engine ALREADY HAS BOTH — folding the review in whole
// would put two sheets of the same name in one file, and a reader would have no way to tell which
// was which. What the premium workbook does not carry is the review's other three answers:
//
//   - the DISTRICT MANAGER rollup, which exists nowhere in the engine;
//   - each area's value MONTH BY MONTH, where the engine stops at families;
//   - each product's value month by month, likewise.
//
// So this adds what is missing rather than what is available, and the two files stay distinguishable.
//
// VALUE, NEVER UNITS, on both by-month sheets. `productUnitsByMonth` exists and is deliberately not
// used here: a row that spans more than one product code carries `unitsAreAddable: false`, and a
// column of such rows cannot be summed. Value spans concentrations safely, which is the owner's
// standing rule and the reason the review computes both.

import type { ClosingPerformanceReview } from "./closing-performance-review";
import type { EngineValue, ReviewColumnFormat } from "./closing-engine-fill";

/**
 * What a row IS, which decides how it is dressed and whether it folds.
 *
 * `detail` is an ordinary row and the default for every sheet that says nothing. `group` is a bar
 * that opens a block and summarises the detail rows beneath it. `total` closes the sheet.
 */
export type ReviewSheetRowKind = "detail" | "group" | "total";

/** A sheet this module asks the filler to create, declaratively — no OOXML in here. */
export type ReviewSheet = {
  /**
   * Put this tab immediately AFTER the named sheet instead of on the end of the tab strip.
   *
   * 🔴 IT IS NOT A COSMETIC PREFERENCE AND IT IS NOT FREE. `localSheetId` on a defined name is a
   * POSITION in the workbook's sheet list, not a name, so a sheet inserted anywhere but the end
   * silently re-attaches every print area, print title and filter range at or after that position
   * to its neighbour — the defect `addIndexSheet` pays for deliberately and documents at length.
   * The filler shifts those ids to match, which is the only reason this option can exist; it stays
   * absent on every sheet that does not NEED a position, which is all three of the review's own.
   *
   * It exists for the Office-free matrix twin, which the owner asked for as the tab that "will
   * follow the closing matrix" (2026-10-05) — a grid meant to be read line for line against the one
   * beside it is worth the shift, and a copy of it eleven tabs away is not. A name that is not in
   * the workbook is ignored and the sheet simply appends, so a renamed template cannot fail an
   * export.
   */
  after?: string;
  /**
   * The contents page heading this sheet is listed under. Absent means "Performance review", which
   * is where every sheet built here belongs.
   *
   * It exists because the appended-sheet mechanism is no longer the review's alone — the quarter
   * gap tab rides it too, and listing that under "Performance review" would file it under a heading
   * that describes a different question. A band with no sheets is never printed, so a sheet that
   * names its own band takes its heading with it when it is absent.
   */
  band?: string;
  /** Tab name. Must not collide with a sheet the engine template already has. */
  name: string;
  /** A1, in the engine's own "Title   Month   Line   ·   what it is" shape. */
  title: string;
  /** The line under the header row, listing what the sheet counts. */
  subtitle: string;
  /**
   * A number format named per column, for a column whose HEADING cannot imply it — see
   * `ReviewColumnFormat`.
   *
   * Positional against `headers`; null or absent leaves that column to `reviewColumnStyle`, which
   * is what every sheet built from aggregates wants. It exists for the invoice-grain Rows tab,
   * whose units are legitimately fractional and whose row id is an identifier, not money.
   */
  columnFormats?: readonly (ReviewColumnFormat | null)[];
  /** Column headings, in order. */
  headers: string[];
  /** Column widths, in Excel's own units. One per heading; missing ones take a default. */
  widths: number[];
  /** Data rows, positional against `headers`. */
  rows: EngineValue[][];
  /**
   * Fold each block's `detail` rows under the `group` bar ABOVE them.
   *
   * The summary sits above its detail, which is not Excel's default and has to be said in the
   * sheet's own `outlinePr`: left at the default the margin's minus signs point at the block BELOW
   * the one they collapse, and every control on the sheet is then off by a block.
   *
   * Ignored on a sheet with no `group` rows — there would be nothing to fold under.
   */
  grouped?: boolean;
  /**
   * What each row is, positional against `rows`. Absent means every row is a plain detail row,
   * which is what the review's own three sheets are.
   */
  rowKinds?: ReviewSheetRowKind[];
  /** The line the contents page prints beside this sheet's name. */
  what: string;
};

const money = (value: number | null | undefined): EngineValue =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

/** A ratio stays a ratio — the sheet formats it, so rounding here would lose the percentage. */
const ratio = (value: number | null | undefined): EngineValue =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * `2026-08` as `Aug 2026`, the way the engine's own month columns read.
 *
 * Exported because the quarter gap tab sits beside these three and its masthead has to read
 * identically — two spellings of the same month on adjacent tabs is the kind of difference a reader
 * stops to work out.
 */
export function closingSheetMonthLabel(period: string): string {
  const [year, month] = period.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const index = Number(month) - 1;
  return names[index] ? `${names[index]} ${year}` : period;
}

/**
 * The review's sheets for this line and month.
 *
 * Returns only the sheets that HAVE rows. An empty sheet in a workbook reads as a missing number
 * rather than as an absent question, and the contents page would then promise a page with nothing
 * on it.
 */
export function buildReviewSheets(
  review: ClosingPerformanceReview,
  input: { line: string | null; period: string | null },
): ReviewSheet[] {
  const stamp = [input.period ? closingSheetMonthLabel(input.period) : null, input.line]
    .filter(Boolean)
    .join("   ");
  //
  // ⚠ THE MASTHEAD IS THE NAME, THE MONTH AND THE LINE — NOTHING ELSE, and that is what makes
  // room for the emblem. These sheets are five or six columns, about 750px, and the descriptive
  // tail that used to run along here took the caption to 640px of it: there was nowhere left to put
  // the mark, which is why these three tabs carried no logo at all. The tail also said the same
  // thing as `subtitle` one row below it, word for word.
  const title = (name: string) => `${name}   ${stamp}`;
  const sheets: ReviewSheet[] = [];

  // ── District managers ───────────────────────────────────────────────────────────────────────
  if (review.managers.length > 0) {
    sheets.push({
      headers: ["District manager", "Region", "Areas", "Sales value", "Target value", "Achievement"],
      name: "District Managers",
      rows: review.managers.map((manager) => [
        manager.label,
        manager.regionName,
        manager.areaCount,
        money(manager.salesValue),
        money(manager.targetValue),
        ratio(manager.achievement),
      ]),
      subtitle: "Every district manager's areas rolled up, by value against their own targets.",
      title: title("District Managers"),
      what: "Every district manager's areas rolled into one row — the rollup the engine has nowhere else.",
      widths: [30, 18, 9, 16, 16, 14],
    });
  }

  // ── The by-month series ─────────────────────────────────────────────────────────────────────
  // One column per month, oldest first, then the newest month over the one before it. A month that
  // was never uploaded is null and prints as blank, not as a zero — a zero would read as "sold
  // nothing", which is a different and much worse claim.
  const months = review.months ?? [];
  const series = (
    rows: ClosingPerformanceReview["areaValueByMonth"],
    name: string,
    firstHeading: string,
    secondHeading: string,
    what: string,
  ): ReviewSheet | null => {
    if (rows.length === 0 || months.length === 0) return null;
    return {
      headers: [firstHeading, secondHeading, ...months.map(closingSheetMonthLabel), "Against the month before"],
      name,
      rows: rows.map((row) => [
        row.label,
        row.subLabel,
        ...row.perMonth.map((value) => money(value)),
        // "—" (a base of zero or below) has no ratio, so the cell stays blank like "new".
        ratio(typeof row.growth === "number" ? row.growth : null),
      ]),
      subtitle:
        `${months.length === 1 ? "One month" : `${months.length} months`}, oldest first. `
        + "By value, never units — a row spanning more than one product code cannot have its units summed.",
      title: title(name),
      what,
      widths: [26, 20, ...months.map(() => 14), 20],
    };
  };

  const areaSeries = series(
    review.areaValueByMonth,
    "Area by Month",
    "Area",
    "Region",
    "Each area's value month by month, with the newest month against the one before it.",
  );
  if (areaSeries) sheets.push(areaSeries);

  const productSeries = series(
    review.productValueByMonth,
    "Product by Month",
    "Product",
    "Family",
    "Each product's value month by month — value, because units cannot be summed across products.",
  );
  if (productSeries) sheets.push(productSeries);

  return sheets;
}
