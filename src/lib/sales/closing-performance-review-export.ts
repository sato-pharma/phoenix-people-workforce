import ExcelJS from "exceljs";
import { HOUSE_XLSX_DISPLAY_FONT, HOUSE_XLSX_FONT } from "@/lib/export/house-xlsx-palette";

import { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_COLORS } from "@/lib/export/house-xlsx-identity";
import {
  performanceReviewRegionStyle,
  PERFORMANCE_REVIEW_FIRST_PERIOD,
  PERFORMANCE_REVIEW_REGIONS,
  type ClosingPerformanceReview,
  type PerformanceMatrix,
  type PerformanceProductMonthMatrix,
  type PerformanceReviewSeriesRow,
} from "@/lib/sales/closing-performance-review";
import {
  GROWTH_NO_BASE,
  longMonthLabel as longMonthName,
  reviewGrowthOf,
  reviewShowsLessThanTheWholeLine,
  reviewTotalRowLabel,
  type PerformanceReviewGrowth,
} from "@/lib/sales/closing-performance-review-regions";
import { SATO_LOGO_ON_LIGHT_PNG_BASE64 } from "@/lib/sales/sato-logo-asset";
import { unprotectExcelWorkbook } from "@/lib/sales/closing-workbook-lock";

// ─────────────────────────────────────────────────────────────────────────────
// The Performance Review workbook.
//
// It renders exactly what the page shows — same rows, same order, same numbers, from the same
// ClosingPerformanceReview object. An export that quietly carried a different set of numbers from
// the screen it was launched from is the usual reason a report and its export disagree, and the
// owner's rule is that the file must match the screen.
//
// Units appear only where the thing being counted IS one product code: "Units & Growth by Month",
// where every ROW is one product, and "Reps · Products by Month", where every BLOCK is one product
// and the months sit inside it. Everywhere else the measure is VALUE, because units of different
// products and concentrations are never added. `unitsAreAddable` carries that decision from the
// domain layer; this file asserts it rather than re-deciding it.
// ─────────────────────────────────────────────────────────────────────────────

// ── The house document identity — SATO-DIS-2026-01 v1.0 ──────────────────────
//
// Every colour here is the COMPANY's, measured from the Sato Pharma mark, never the Phoenix app's.
// The ink rule holds: colour is carried by LINES and TYPE, never by filled area. The one permitted
// fill in the whole format is the 6% zebra row.
//
// What that removed from this workbook: a full-width blue bar above the masthead, a navy bar below
// it, a navy header band on every sheet, a navy section bar, a pale band on every total row, and a
// pastel region tint down the first five columns of every body row. The region survived all of it
// intact, because the row already SAYS its region, in words, in that region's own colour, in a
// column of its own — a fill may only go when the cell says the thing without it.
const BLUE = HOUSE_XLSX_COLORS.blue;
const DEEP = HOUSE_XLSX_COLORS.deep;
const LIGHT = HOUSE_XLSX_COLORS.light;
const ZEBRA = HOUSE_XLSX_COLORS.tint;
const RULE = HOUSE_XLSX_COLORS.hair;
const INK = HOUSE_XLSX_COLORS.body;
// The house palette carries ONE secondary tone, not two. SLATE and MUTE therefore resolve to the
// same value, and the distinction they used to draw in colour is now drawn in size and italic —
// the standard's own discipline, and the reason an absent value keeps its em-dash glyph.
const SLATE = HOUSE_XLSX_COLORS.muted;
const MUTE = HOUSE_XLSX_COLORS.muted;
// The achievement ramp and the growth arrows are TYPE, which is what the ink rule says colour
// SHOULD be carried by, so they keep a real three-step reading. Grey is not available as the middle
// step: it already means "no target" a few columns to the left, and one colour cannot mean both
// "unmeasured" and "measured, and mid". The red is the standard's own sanctioned non-logo colour
// rather than a second red invented here.
const GOOD = "FF0F766E";
const WARN = "FF9A5B08";
const WHITE = HOUSE_XLSX_COLORS.white;
const CRIT = HOUSE_XLSX_COLORS.flag;
const UP = GOOD;
const DOWN = CRIT;

// Written as escapes so no editor, terminal or patch tool can mangle them into a literal.
const BLK = String.fromCharCode(0x2588);
const SQ = String.fromCharCode(0x25a0);
const DOT = String.fromCharCode(0x00b7);
const EM = String.fromCharCode(0x2014);

const NUM = "#,##0";
const PCT = "0.0%";
const GROW = "+#,##0.0%;−#,##0.0%;0.0%";

// The grid is hairlines in house hair, not a thin box on every cell: with the fills gone the rules
// are doing the whole job of separating rows, and a "thin" grid at that density reads as a cage.
const thin = { color: { argb: RULE }, style: "hair" as const };
const med = { color: { argb: LIGHT }, style: "medium" as const };
const medB = { color: { argb: BLUE }, style: "medium" as const };

type Cell = ExcelJS.Cell;
type Sheet = ExcelJS.Worksheet;

function border(cell: Cell, o: { b?: ExcelJS.Border; l?: ExcelJS.Border; r?: ExcelJS.Border; t?: ExcelJS.Border } = {}) {
  cell.border = { bottom: o.b ?? thin, left: o.l ?? thin, right: o.r ?? thin, top: o.t ?? thin };
  return cell;
}
function fill(cell: Cell, argb: string) {
  cell.fill = { fgColor: { argb }, pattern: "solid", type: "pattern" };
  return cell;
}
function font(cell: Cell, value: Partial<ExcelJS.Font>) {
  cell.font = value;
  return cell;
}
function align(cell: Cell, value: Partial<ExcelJS.Alignment>) {
  // wrapText is false everywhere, deliberately: the owner's rule is that text never wraps to a
  // second line and is never cut off with an ellipsis. Columns are sized to the longest real value.
  cell.alignment = { wrapText: false, ...value };
  return cell;
}

const achColor = (ratio: number | null) =>
  ratio == null ? MUTE : ratio >= 0.8 ? GOOD : ratio >= 0.55 ? WARN : CRIT;

/** A 14-block bar. Purely a reading aid beside the percentage it mirrors. */
const bar = (ratio: number | null) => BLK.repeat(Math.max(0, Math.min(14, Math.round((ratio ?? 0) * 14))));

function money(
  cell: Cell,
  value: number | null,
  options: { bold?: boolean; color?: string; na?: boolean; zeroDot?: boolean } = {},
) {
  const { bold = false, color = INK, na = false, zeroDot = true } = options;
  if (na || value == null) {
    cell.value = EM;
    align(cell, { horizontal: "center" });
    font(cell, { color: { argb: MUTE }, name: HOUSE_XLSX_FONT, size: 9 });
    return cell;
  }
  if (value === 0 && zeroDot) {
    cell.value = DOT;
    align(cell, { horizontal: "center" });
    font(cell, { color: { argb: MUTE }, name: HOUSE_XLSX_FONT, size: 9 });
    return cell;
  }
  cell.value = value;
  cell.numFmt = NUM;
  align(cell, { horizontal: "right" });
  font(cell, { bold, color: { argb: color }, name: HOUSE_XLSX_FONT, size: 9.5 });
  return cell;
}

function pct(cell: Cell, ratio: number | null, options: { bold?: boolean } = {}) {
  if (ratio == null) {
    // "no target" is a fact about the area, not a system state — an area outside the target sheet
    // genuinely has nothing to be measured against, and printing 0% would accuse it of failing.
    cell.value = "no target";
    align(cell, { horizontal: "center" });
    font(cell, { color: { argb: MUTE }, italic: true, name: HOUSE_XLSX_FONT, size: 8.5 });
    return cell;
  }
  cell.value = ratio;
  cell.numFmt = PCT;
  align(cell, { horizontal: "center" });
  font(cell, { bold: true, color: { argb: achColor(ratio) }, name: HOUSE_XLSX_FONT, size: options.bold ? 10.5 : 9.5 });
  return cell;
}

function growth(cell: Cell, ratio: PerformanceReviewGrowth) {
  // The month before stood at zero or below — no growth to compute, and never a percentage off a
  // negative base (Luxor's −1 printed −4938.9%).
  if (ratio === GROWTH_NO_BASE) {
    cell.value = "—";
    align(cell, { horizontal: "center" });
    font(cell, { color: { argb: MUTE }, name: HOUSE_XLSX_FONT, size: 8.5 });
    return cell;
  }
  if (ratio == null) {
    cell.value = "new";
    align(cell, { horizontal: "center" });
    font(cell, { color: { argb: MUTE }, italic: true, name: HOUSE_XLSX_FONT, size: 8.5 });
    return cell;
  }
  cell.value = ratio;
  cell.numFmt = GROW;
  align(cell, { horizontal: "center" });
  font(cell, { bold: true, color: { argb: ratio >= 0 ? UP : DOWN }, name: HOUSE_XLSX_FONT, size: 9.5 });
  return cell;
}

const PAGE: Partial<ExcelJS.PageSetup> = {
  fitToHeight: 0,
  fitToPage: true,
  fitToWidth: 1,
  margins: { bottom: 0.4, footer: 0.2, header: 0.2, left: 0.25, right: 0.25, top: 0.4 },
  orientation: "landscape",
  paperSize: 9,
};

/**
 * "2026-07" → "July 2026", with this module's own em dash for an empty period.
 *
 * The formatting itself moved to `closing-performance-review-regions.ts` (the dependency-free module)
 * so the portal page can print a month in words without pulling ExcelJS in; this keeps the name every
 * existing caller imports, and the sheet's own blank.
 */
export function longMonthLabel(period: string | null | undefined): string {
  return longMonthName(period) || EM;
}

/**
 * What the headline sheets cover, in words.
 *
 * `review.period` is the LATEST month of the selection, so labelling a three-month total with it
 * would print "September 2026" over figures that also hold July and August. Every headline sheet
 * asks this instead of reading `period` directly.
 *
 * The by-MONTH sheets keep their own `seriesSpanLabel` — those columns really are one month each.
 */
export function headlinePeriodLabel(review: ClosingPerformanceReview): string {
  const periods = review.selectedPeriods ?? [];
  if (periods.length <= 1) return longMonthLabel(review.period);
  const first = longMonthLabel(periods[0]);
  const last = longMonthLabel(periods[periods.length - 1]);
  return periods.length === 2 ? `${first} and ${last}` : `${periods.length} months ${DOT} ${first} to ${last}`;
}

/**
 * How the sheet says it is showing less than the whole line.
 *
 * The owner's rule is that an export matches the screen and that what is left out is LABELLED, never
 * silently dropped. Both counts are already in the payload — the surviving rows, and the pickers'
 * full option lists — so this needs no new field and cannot drift from what was filtered.
 *
 * Empty string when nothing was narrowed, so an unfiltered workbook reads exactly as it always has.
 *
 * The TRIGGER is `reviewShowsLessThanTheWholeLine`, not these parts, so that this masthead and the
 * total row's own wording cannot drift: a sheet whose masthead says "filtered" always has a total row
 * that says FILTERED TOTAL, and one that says NATIONAL TOTAL always has an empty scope here.
 *
 * 🔴 **A BOUNDED VIEWER'S SHEET SAYS SO EVEN WITH NO FILTER SET** (owner, 2026-10-13). A sales
 * manager's own workbook covers his territory, and the two counts below cannot see that: his pickers
 * are built from his own areas, so they agree. Without the `scopeIsBounded` branch his file would
 * carry a FILTERED TOTAL with a masthead that never says what it was narrowed to — which is the same
 * unlabelled sheet this function exists to prevent, one layer up.
 */
export function scopeLabel(review: ClosingPerformanceReview): string {
  if (!reviewShowsLessThanTheWholeLine(review)) return "";
  const allAreas = review.filterOptions?.areas.length ?? 0;
  const allProducts = review.filterOptions?.products.length ?? 0;
  const parts: string[] = [];
  if (allAreas > 0 && review.areas.length < allAreas) {
    parts.push(`${review.areas.length} of ${allAreas} areas`);
  }
  if (allProducts > 0 && review.matrixByProduct.columns.length < allProducts) {
    parts.push(`${review.matrixByProduct.columns.length} of ${allProducts} products`);
  }
  if (parts.length > 0) return `filtered ${DOT} ${parts.join(` ${DOT} `)}`;
  if (review.scopeIsBounded) {
    return `own territory ${DOT} ${review.areas.length} ${review.areas.length === 1 ? "area" : "areas"}`;
  }
  return "";
}

/** A subtitle with the scope appended, when there is one. Keeps the unfiltered wording untouched. */
function withScope(review: ClosingPerformanceReview, subtitle: string): string {
  const scope = scopeLabel(review);
  return scope === "" ? subtitle : `${subtitle} ${DOT} ${scope}`;
}

/** "2026-07" → "JUL". Used for the narrow month columns of the by-month sheets. */
export function shortMonthLabel(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period.trim());
  if (!match) return period.trim().toUpperCase();
  const names = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return names[Number(match[2]) - 1] ?? period.toUpperCase();
}

type MastheadOptions = {
  legend: "regions" | "growth" | "none";
  lastCol: number;
  note: string;
  status: string;
  subtitle: string;
  title: string;
};

/**
 * Rows 1-8, in the house identity.
 *
 * The footprint is unchanged at eight rows — every sheet builder below starts its header at row 9
 * and freezes there, and the by-month legend and note lines are content this report needs, not
 * decoration to be dropped. What changed is the ink. The specimen's lockup is horizontal: the mark
 * sits physically left and the title reads BESIDE it, with the standard's own id right-aligned
 * opposite, and a single Brand Blue rule running the full width beneath. That is one short filled
 * row in place of the two full-width bars this masthead used to carry.
 */
function masthead(workbook: ExcelJS.Workbook, sheet: Sheet, options: MastheadOptions) {
  const letter = sheet.getColumn(options.lastCol).letter;

  // The title begins in the first column that clears the floating mark, so the lockup reads as one
  // horizontal unit whatever the sheet's columns happen to be. The mark is 96pt ≈ 18 of Excel's
  // character-width units, and these seven sheets range from a 6-wide first column to a 42-wide one:
  // a fixed "start at C" clears the mark on the ranking sheet and wastes 66 characters on the series
  // sheets. Measuring is two lines and cannot be wrong.
  let titleFirst = 1;
  for (let width = 0; titleFirst < options.lastCol && width < 19; titleFirst += 1) {
    width += sheet.getColumn(titleFirst).width ?? 8.43;
  }

  // Row 1 — the standard's own id, right-aligned above everything.
  //
  // It gets a row of its own rather than the trailing columns of the title row, because those
  // columns are 12 characters wide on one sheet and 34 on another: opposite the title it either fits
  // or silently CLIPS the headline it sits beside, and which of those happens depends on how many
  // months the series covers. A full-width row cannot clip at any width.
  sheet.getRow(1).height = 11;
  sheet.mergeCells(`A1:${letter}1`);
  align(font(sheet.getCell("A1"), { color: { argb: MUTE }, name: HOUSE_XLSX_FONT, size: 7.5 }), {
    horizontal: "right",
    vertical: "middle",
  }).value = HOUSE_DOCUMENT_STANDARD;

  sheet.getRow(2).height = 24;
  sheet.getRow(3).height = 14;
  sheet.getRow(4).height = 13;
  // Title, subtitle and status all start at the same column, to the RIGHT of the mark. The mark
  // floats over rows 2-3 of the columns before it, so a subtitle merged from column A would render
  // underneath the wordmark on the four sheets whose first column is 34 characters or wider.
  sheet.mergeCells(2, titleFirst, 2, options.lastCol);
  sheet.mergeCells(3, titleFirst, 3, options.lastCol);
  sheet.mergeCells(4, titleFirst, 4, options.lastCol);
  align(font(sheet.getCell(2, titleFirst), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_DISPLAY_FONT, size: 16 }), {
    horizontal: "left",
    vertical: "middle",
  }).value = options.title;
  align(font(sheet.getCell(3, titleFirst), { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 10 }), {
    horizontal: "left",
  }).value = options.subtitle;
  align(font(sheet.getCell(4, titleFirst), { color: { argb: MUTE }, italic: true, name: HOUSE_XLSX_FONT, size: 8.5 }), {
    horizontal: "left",
  }).value = options.status;

  try {
    const image = workbook.addImage({ base64: SATO_LOGO_ON_LIGHT_PNG_BASE64, extension: "png" });
    // 401x158 native, so 96x38 holds the 2.54:1 ratio and keeps the PHARMA counters open.
    sheet.addImage(image, { ext: { height: 38, width: 96 }, tl: { col: 0.2, row: 1.15 } });
  } catch {
    // The wordmark is presentation, never data — a failed embed must not lose the report.
  }

  // Row 5 — the brand rule. A rule, not a band: one short row, which is the single filled shape the
  // ink rule allows outside the zebra.
  sheet.getRow(5).height = 3;
  for (let column = 1; column <= options.lastCol; column += 1) fill(sheet.getCell(5, column), BLUE);

  sheet.getRow(6).height = 15;
  sheet.mergeCells(`A6:${letter}6`);
  if (options.legend === "regions") {
    const runs: ExcelJS.RichText[] = [
      { font: { bold: true, color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 8.5 }, text: "REGION  " },
    ];
    for (const region of PERFORMANCE_REVIEW_REGIONS) {
      runs.push({ font: { color: { argb: region.chip }, name: HOUSE_XLSX_FONT, size: 11 }, text: SQ });
      runs.push({ font: { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 8.5 }, text: ` ${region.regionName}    ` });
    }
    sheet.getCell("A6").value = { richText: runs };
  } else if (options.legend === "growth") {
    sheet.getCell("A6").value = {
      richText: [
        { font: { color: { argb: UP }, name: HOUSE_XLSX_FONT, size: 11 }, text: SQ },
        { font: { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 8.5 }, text: " grew on the month     " },
        { font: { color: { argb: DOWN }, name: HOUSE_XLSX_FONT, size: 11 }, text: SQ },
        { font: { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 8.5 }, text: " fell on the month     " },
        {
          font: { color: { argb: MUTE }, name: HOUSE_XLSX_FONT, size: 8.5 },
          text: "new = nothing on record the month before    — = the month before was zero or below",
        },
      ],
    };
  }
  align(sheet.getCell("A6"), { horizontal: "left", indent: 1, vertical: "middle" });

  sheet.getRow(7).height = 13;
  sheet.mergeCells(`A7:${letter}7`);
  align(font(sheet.getCell("A7"), { color: { argb: MUTE }, name: HOUSE_XLSX_FONT, size: 8 }), {
    horizontal: "left",
    indent: 1,
  }).value = `${DOT} = nothing sold    ${EM} = not applicable    ${options.note}`;

  sheet.getRow(8).height = 7;
}

/** A section break: deep type over a Brand Blue rule, no band. */
function sectionRow(sheet: Sheet, row: number, lastCol: number, text: string, sub?: string) {
  const letter = sheet.getColumn(lastCol).letter;
  sheet.mergeCells(`A${row}:${letter}${row}`);
  sheet.getRow(row).height = 18;
  const cell = sheet.getCell(row, 1);
  cell.value = {
    richText: [
      { font: { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 10 }, text },
      ...(sub ? [{ font: { color: { argb: MUTE }, name: HOUSE_XLSX_FONT, size: 8.5 }, text: `     ${sub}` }] : []),
    ],
  };
  align(cell, { horizontal: "left", indent: 1, vertical: "bottom" });
  // Set directly rather than through border(), which fills every unnamed side with a hairline: a
  // section break is a rule under a label, never a box.
  for (let column = 1; column <= lastCol; column += 1) {
    sheet.getCell(row, column).border = { bottom: medB };
  }
}

/**
 * The house table header: deep bold type on white, under a rule.
 *
 * `band` was the paler of two filled bands; it is now the paler of two rules — the Brand Blue rule
 * marks a real column header, the light rule marks the grouping strip that sits above one.
 */
function headerRow(sheet: Sheet, row: number, headings: string[], leftCount: number, options: { band?: boolean } = {}) {
  sheet.getRow(row).height = options.band ? 22 : 26;
  headings.forEach((heading, index) => {
    const cell = sheet.getCell(row, index + 1);
    cell.value = heading;
    // White on a Brand Blue band. A header with no ground does not separate from its data on a sheet
    // this wide — the product grids run to twenty-odd columns — and the ink rule that put type on
    // white here is a rule about PAPER, measured in page coverage.
    font(cell, { bold: true, color: { argb: WHITE }, name: HOUSE_XLSX_FONT, size: 8.5 });
    fill(cell, options.band ? LIGHT : BLUE);
    align(cell, {
      horizontal: index < leftCount ? "left" : "center",
      indent: index < leftCount ? 1 : 0,
      vertical: "middle",
    });
    border(cell, { b: medB, l: thin, r: thin, t: medB });
  });
}

/** How strongly a body row is marked. `area` is an ordinary row; the other two are totals. */
type RowEmphasis = "area" | "subtotal" | "total";

/**
 * Rule one body row and hand back its cells.
 *
 * The region tint that used to run down the first columns is gone: the row names its region in that
 * region's own colour a column or two along, so the tint was saying a second time what the type
 * already said. A total is now marked by rules and weight rather than by a band.
 */
function bodyRow(sheet: Sheet, row: number, lastCol: number, options: { emphasis?: RowEmphasis; zebra: boolean }) {
  const emphasis = options.emphasis ?? "area";
  const cells: Cell[] = [];
  for (let column = 1; column <= lastCol; column += 1) {
    const cell = sheet.getCell(row, column);
    // The zebra sits OVER the grid rather than instead of it — `border()` fills every unnamed side
    // with a hairline, so a tinted row is ruled like any other. The grid separates the columns; the
    // tint holds a row together across them.
    if (emphasis === "area" && options.zebra) fill(cell, ZEBRA);
    border(cell, {
      b: emphasis === "total" ? medB : emphasis === "subtotal" ? med : thin,
      l: undefined,
      r: undefined,
      t: emphasis === "area" ? thin : emphasis === "total" ? medB : med,
    });
    cells.push(cell);
  }
  return cells;
}

// ── Sheet 1 — Rep Ranking ────────────────────────────────────────────────────

function buildRepRankingSheet(workbook: ExcelJS.Workbook, review: ClosingPerformanceReview) {
  const sheet = workbook.addWorksheet("Rep Ranking", {
    pageSetup: PAGE,
    views: [{ showGridLines: false, state: "frozen", ySplit: 9 }],
  });
  sheet.columns = [
    { width: 6 }, { width: 15 }, { width: 54 }, { width: 30 }, { width: 34 },
    { width: 16 }, { width: 16 }, { width: 12 }, { width: 17 },
  ];
  const LAST = 9;

  masthead(workbook, sheet, {
    legend: "regions",
    lastCol: LAST,
    note: `ranked on achievement ${DOT} a rep sells many products, so a rep total is by VALUE: units of different products are never added`,
    status: `source: Monthly Closing ${DOT} rep and manager from the Organogram seat model`,
    subtitle: withScope(review, `${review.line ?? EM} ${DOT} National ${DOT} ${headlinePeriodLabel(review)}`),
    title: "MEDICAL REP RANKING",
  });

  let row = 9;
  headerRow(sheet, row, ["RANK", "REGION", "MEDICAL REP", "AREA", "DISTRICT MANAGER", "SALES VALUE", "TARGET VALUE", "ACH.", "ACHIEVEMENT"], 5);
  row += 1;

  const firstBodyRow = row;
  review.areas.forEach((area, index) => {
    const style = performanceReviewRegionStyle(area.regionCode);
    sheet.getRow(row).height = 16;
    const cells = bodyRow(sheet, row, LAST, { zebra: index % 2 === 1 });
    const rank = area.achievement == null ? null : index + 1;

    cells[0].value = rank ?? EM;
    align(font(cells[0], { bold: rank != null && rank <= 3, color: { argb: rank != null && rank <= 3 ? DEEP : MUTE }, name: HOUSE_XLSX_FONT, size: 9 }), { horizontal: "center" });

    cells[1].value = area.regionName;
    align(font(cells[1], { bold: true, color: { argb: style.chip }, name: HOUSE_XLSX_FONT, size: 8.5 }), { horizontal: "left", indent: 1 });

    // "Vacant seat" is a real fact about a real seat, and the only non-name this column may show.
    cells[2].value = area.repName ?? (area.repIsVacant ? "Vacant seat" : EM);
    align(font(cells[2], { color: { argb: area.repName ? INK : MUTE }, italic: !area.repName, name: HOUSE_XLSX_FONT, size: 9.5 }), { horizontal: "left", indent: 1 });

    cells[3].value = area.areaName;
    align(font(cells[3], { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 9 }), { horizontal: "left", indent: 1 });

    cells[4].value = area.managerName ?? EM;
    align(font(cells[4], { color: { argb: area.managerName ? SLATE : MUTE }, name: HOUSE_XLSX_FONT, size: 9 }), { horizontal: "left", indent: 1 });

    money(cells[5], area.salesValue, { bold: true });
    money(cells[6], area.targetValue, { color: SLATE, na: area.targetValue == null });
    pct(cells[7], area.achievement, { bold: true });

    cells[8].value = bar(area.achievement);
    align(font(cells[8], { color: { argb: achColor(area.achievement) }, name: HOUSE_XLSX_FONT, size: 7 }), { horizontal: "left", indent: 1 });
    row += 1;
  });

  // National total
  sheet.getRow(row).height = 20;
  for (let column = 1; column <= LAST; column += 1) {
    border(sheet.getCell(row, column), { b: medB, t: medB });
  }
  sheet.mergeCells(row, 1, row, 5);
  align(font(sheet.getCell(row, 1), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 10 }), {
    horizontal: "left",
    indent: 1,
    vertical: "middle",
  }).value = `${(review.line ?? "").toUpperCase()} LINE ${DOT} ${reviewTotalRowLabel(review).toUpperCase()}`;
  money(sheet.getCell(row, 6), review.totals.salesValue, { bold: true, color: DEEP });
  money(sheet.getCell(row, 7), review.totals.targetValue, { bold: true, color: DEEP, na: review.totals.targetValue == null });
  pct(sheet.getCell(row, 8), review.totals.achievement, { bold: true });
  align(font(sheet.getCell(row, 9), { color: { argb: achColor(review.totals.achievement) }, name: HOUSE_XLSX_FONT, size: 7 }), {
    horizontal: "left",
    indent: 1,
  }).value = bar(review.totals.achievement);
  row += 2;

  // District managers
  sectionRow(sheet, row, LAST, "DISTRICT MANAGERS", "each is named beside the region he or she runs");
  row += 1;
  headerRow(sheet, row, ["", "REGION", "DISTRICT MANAGER", "AREAS", "", "SALES VALUE", "TARGET VALUE", "ACH.", "ACHIEVEMENT"], 5, { band: true });
  row += 1;
  review.managers.forEach((group, index) => {
    const style = performanceReviewRegionStyle(group.regionCode);
    sheet.getRow(row).height = 17;
    const cells = bodyRow(sheet, row, LAST, { zebra: index % 2 === 1 });
    align(cells[0], { horizontal: "center" });
    cells[1].value = group.regionName;
    align(font(cells[1], { bold: true, color: { argb: style.chip }, name: HOUSE_XLSX_FONT, size: 8.5 }), { horizontal: "left", indent: 1 });
    cells[2].value = group.label;
    align(font(cells[2], { bold: true, color: { argb: INK }, name: HOUSE_XLSX_FONT, size: 9.5 }), { horizontal: "left", indent: 1 });
    cells[3].value = `${group.areaCount} ${group.areaCount === 1 ? "area" : "areas"}`;
    align(font(cells[3], { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 9 }), { horizontal: "left", indent: 1 });
    money(cells[5], group.salesValue, { bold: true });
    money(cells[6], group.targetValue, { color: SLATE, na: group.targetValue == null });
    pct(cells[7], group.achievement, { bold: true });
    cells[8].value = bar(group.achievement);
    align(font(cells[8], { color: { argb: achColor(group.achievement) }, name: HOUSE_XLSX_FONT, size: 7 }), { horizontal: "left", indent: 1 });
    row += 1;
  });
  row += 1;

  // Regions
  sectionRow(sheet, row, LAST, "REGIONS", "the colour every sheet of this workbook names a region in");
  row += 1;
  review.regions.forEach((group, index) => {
    const style = performanceReviewRegionStyle(group.regionCode);
    sheet.getRow(row).height = 17;
    const cells = bodyRow(sheet, row, LAST, { zebra: index % 2 === 1 });
    align(font(cells[0], { color: { argb: style.chip }, name: HOUSE_XLSX_FONT, size: 12 }), { horizontal: "center" }).value = SQ;
    sheet.mergeCells(row, 2, row, 3);
    align(font(sheet.getCell(row, 2), { bold: true, color: { argb: style.chip }, name: HOUSE_XLSX_FONT, size: 10 }), { horizontal: "left", indent: 1 }).value = group.regionName;
    cells[3].value = `${group.areaCount} ${group.areaCount === 1 ? "area" : "areas"}`;
    align(font(cells[3], { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 9 }), { horizontal: "left", indent: 1 });
    money(cells[5], group.salesValue, { bold: true });
    money(cells[6], group.targetValue, { color: SLATE, na: group.targetValue == null });
    pct(cells[7], group.achievement, { bold: true });
    cells[8].value = bar(group.achievement);
    align(font(cells[8], { color: { argb: achColor(group.achievement) }, name: HOUSE_XLSX_FONT, size: 7 }), { horizontal: "left", indent: 1 });
    row += 1;
  });

  if (review.areas.length > 0) {
    sheet.autoFilter = { from: { column: 1, row: 9 }, to: { column: LAST, row: firstBodyRow + review.areas.length - 1 } };
  }
}

// ── Sheet 2 — Family Performance ─────────────────────────────────────────────

function buildFamilySheet(workbook: ExcelJS.Workbook, review: ClosingPerformanceReview) {
  const sheet = workbook.addWorksheet("Family Performance", {
    pageSetup: PAGE,
    views: [{ showGridLines: false, state: "frozen", ySplit: 9 }],
  });
  sheet.columns = [{ width: 40 }, { width: 12 }, { width: 18 }, { width: 18 }, { width: 12 }, { width: 17 }];
  const LAST = 6;

  masthead(workbook, sheet, {
    legend: "none",
    lastCol: LAST,
    note: "a family spans several concentrations, so it is measured by VALUE; units show only where the family is a single product code",
    status: `source: Monthly Closing ${DOT} ${headlinePeriodLabel(review)}`,
    subtitle: withScope(review, `${review.line ?? EM} ${DOT} by product family ${DOT} ${headlinePeriodLabel(review)}`),
    title: "FAMILY PERFORMANCE",
  });

  let row = 9;
  headerRow(sheet, row, ["PRODUCT FAMILY", "PRODUCTS", "SALES VALUE", "TARGET VALUE", "ACH.", "ACHIEVEMENT"], 1);
  row += 1;

  review.families.forEach((family, index) => {
    sheet.getRow(row).height = 16;
    const cells = bodyRow(sheet, row, LAST, { zebra: index % 2 === 1 });
    cells[0].value = family.family;
    align(font(cells[0], { color: { argb: INK }, name: HOUSE_XLSX_FONT, size: 9.5 }), { horizontal: "left", indent: 1 });
    cells[1].value = family.productCount;
    align(font(cells[1], { color: { argb: SLATE }, name: HOUSE_XLSX_FONT, size: 9 }), { horizontal: "center" });
    money(cells[2], family.salesValue, { bold: true });
    money(cells[3], family.targetValue, { color: SLATE, na: family.targetValue == null });
    pct(cells[4], family.achievement, { bold: true });
    cells[5].value = bar(family.achievement);
    align(font(cells[5], { color: { argb: achColor(family.achievement) }, name: HOUSE_XLSX_FONT, size: 7 }), { horizontal: "left", indent: 1 });
    row += 1;
  });

  sheet.getRow(row).height = 20;
  for (let column = 1; column <= LAST; column += 1) {
    border(sheet.getCell(row, column), { b: medB, t: medB });
  }
  align(font(sheet.getCell(row, 1), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 10 }), {
    horizontal: "left",
    indent: 1,
    vertical: "middle",
  }).value = "LINE TOTAL";
  money(sheet.getCell(row, 3), review.totals.salesValue, { bold: true, color: DEEP });
  money(sheet.getCell(row, 4), review.totals.targetValue, { bold: true, color: DEEP, na: review.totals.targetValue == null });
  pct(sheet.getCell(row, 5), review.totals.achievement, { bold: true });
}

// ── Sheets 1 and 2 — the grids: reps and areas down the side, products across ─

/**
 * The owner's shape: WHO on the left, WHAT across the top.
 *
 * Four fixed columns name the row — rep, area, district manager, region — then one column per family
 * or per product code, then the row's own total, target and achievement. Frozen at the fourth column
 * so the names stay on screen however far right the products run, which on a fifteen-product line is
 * most of the page.
 *
 * The cell is UNITS on the by-product grid and VALUE on the by-family grid, and that is not a
 * presentation choice: one product code is a real quantity, a family spanning five concentrations is
 * not. The row total is VALUE on both — adding a row's units ACROSS products would be the same error
 * from the other direction, which is why it is never offered.
 */
function buildGridSheet(
  workbook: ExcelJS.Workbook,
  review: ClosingPerformanceReview,
  options: { grid: PerformanceMatrix; measure: "units" | "value"; name: string; note: string; subtitle: string; title: string },
) {
  const { grid } = options;
  if (options.measure === "units" && grid.columns.some((column) => !column.unitsAreAddable)) {
    throw new Error(
      "Refusing to build a units grid whose columns span more than one product: units of different products are never added.",
    );
  }

  const NAMES = 4;
  const LAST = NAMES + grid.columns.length + 3;
  const sheet = workbook.addWorksheet(options.name, {
    pageSetup: PAGE,
    views: [{ showGridLines: false, state: "frozen", xSplit: NAMES, ySplit: 10 }],
  });
  sheet.columns = [
    { width: 34 }, { width: 26 }, { width: 30 }, { width: 15 },
    ...grid.columns.map(() => ({ width: 15 })),
    { width: 17 }, { width: 16 }, { width: 12 },
  ];

  masthead(workbook, sheet, {
    legend: "regions",
    lastCol: LAST,
    note: options.note,
    status: `source: Monthly Closing ${DOT} ${headlinePeriodLabel(review)} ${DOT} ${grid.columns.length} columns ${DOT} ${grid.rows.filter((row) => row.kind === "area").length} areas`,
    subtitle: options.subtitle,
    title: options.title,
  });

  // Band row: on the by-product grid it merges each family across its own concentrations, so the
  // five Tebofortin columns read as one block instead of five unrelated products.
  let row = 9;
  sheet.getRow(row).height = 18;
  for (let column = 1; column <= LAST; column += 1) {
    border(sheet.getCell(row, column), { b: med, t: medB });
  }
  sheet.mergeCells(row, 1, row, NAMES);
  align(font(sheet.getCell(row, 1), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 8.5 }), {
    horizontal: "left",
    indent: 1,
    vertical: "middle",
  }).value = "WHO SOLD IT";
  let runStart = NAMES + 1;
  for (let index = 0; index <= grid.columns.length; index += 1) {
    const previous = grid.columns[index - 1];
    const current = grid.columns[index];
    if (index > 0 && (!current || current.subLabel !== previous.subLabel)) {
      const from = runStart;
      const to = NAMES + index;
      if (to > from) sheet.mergeCells(row, from, row, to);
      align(font(sheet.getCell(row, from), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 8.5 }), {
        horizontal: "center",
        vertical: "middle",
      }).value = previous.subLabel;
      runStart = to + 1;
    }
  }
  sheet.mergeCells(row, LAST - 2, row, LAST);
  align(font(sheet.getCell(row, LAST - 2), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 8.5 }), {
    horizontal: "center",
    vertical: "middle",
  }).value = "THE WHOLE LINE";
  row += 1;

  headerRow(
    sheet,
    row,
    [
      "REP",
      "AREA",
      "DISTRICT MANAGER",
      "REGION",
      ...grid.columns.map((column) => column.label),
      options.measure === "units" ? "TOTAL VALUE" : "TOTAL",
      "TARGET",
      "ACH %",
    ],
    NAMES,
  );
  row += 1;

  const firstBodyRow = row;
  let zebra = false;
  for (const entry of grid.rows) {
    const isTotal = entry.kind !== "area";
    const style = performanceReviewRegionStyle(entry.regionCode);
    if (entry.kind === "area") zebra = !zebra;
    sheet.getRow(row).height = isTotal ? 19 : 16;
    const cells = bodyRow(sheet, row, LAST, {
      emphasis: entry.kind === "grandTotal" ? "total" : entry.kind === "regionSubtotal" ? "subtotal" : "area",
      zebra,
    });

    const ink = isTotal ? DEEP : INK;
    const label = (cell: Cell, value: string, muted = false) => {
      cell.value = value;
      align(
        font(cell, {
          bold: isTotal,
          color: { argb: isTotal ? DEEP : muted ? MUTE : INK },
          italic: muted,
          name: HOUSE_XLSX_FONT,
          size: isTotal ? 9.5 : 9,
        }),
        { horizontal: "left", indent: 1 },
      );
    };

    if (entry.kind === "area") {
      // "Vacant seat" is a real fact about a real seat; a dash is an area the organogram carries no
      // seat for at all. Neither is a system state, and neither may become one — see the test.
      if (entry.repName) label(cells[0], entry.repName);
      else if (entry.repIsVacant) label(cells[0], "Vacant seat", true);
      else label(cells[0], EM, true);
      label(cells[1], entry.areaName);
      label(cells[2], entry.managerName ?? EM, entry.managerName == null);
      cells[3].value = entry.regionName;
      align(font(cells[3], { bold: true, color: { argb: style.chip }, name: HOUSE_XLSX_FONT, size: 8.5 }), {
        horizontal: "left",
        indent: 1,
      });
    } else {
      label(
        cells[0],
        entry.kind === "grandTotal"
          ? reviewTotalRowLabel(review).toUpperCase()
          : `${entry.regionName.toUpperCase()} TOTAL`,
      );
      for (const index of [1, 2, 3]) {
        cells[index].value = "";
        font(cells[index], { color: { argb: ink }, name: HOUSE_XLSX_FONT, size: 9 });
      }
    }

    grid.columns.forEach((column, index) => {
      const cell = cells[NAMES + index];
      const value = options.measure === "units" ? entry.units[index] : entry.values[index];
      money(cell, value ?? null, { bold: isTotal, color: ink, na: value == null });
    });

    money(cells[LAST - 3], entry.salesValue, { bold: true, color: ink });
    money(cells[LAST - 2], entry.targetValue, { bold: isTotal, color: ink, na: entry.targetValue == null });
    pct(cells[LAST - 1], entry.achievement, { bold: isTotal });
    row += 1;
  }

  if (grid.rows.length > 0) {
    sheet.autoFilter = { from: { column: 1, row: 10 }, to: { column: LAST, row: firstBodyRow + grid.rows.length - 1 } };
  }
}

// ── Sheets 4, 5, 6 and 7 — the by-month series ───────────────────────────────

/**
 * How the series states its own span, so a reader never has to wonder what is missing.
 *
 * The series starts at July 2026 and fills forward (PERFORMANCE_REVIEW_FIRST_PERIOD), so on a July
 * closing it is one column wide. That is a fact worth printing rather than leaving to be guessed:
 * one unexplained column reads as a broken report, and "the series starts here" reads as a start.
 *
 * The span is taken from the months actually in hand, so a sales manager reading his own published
 * months — a bounded viewer's list is the published ones, July upward — sees exactly which they are.
 */
function seriesSpanLabel(review: ClosingPerformanceReview): string {
  if (review.months.length === 0) return `the series starts ${longMonthLabel(PERFORMANCE_REVIEW_FIRST_PERIOD)}`;
  if (review.months.length === 1) return `${longMonthLabel(review.months[0])} ${DOT} the series starts here`;
  return `${review.months.length} months ${DOT} ${longMonthLabel(review.months[0])} to ${longMonthLabel(review.months[review.months.length - 1])}`;
}

type SeriesSheetOptions = {
  measure: "units" | "value";
  name: string;
  note: string;
  rowHeading: string;
  rows: PerformanceReviewSeriesRow[];
  subHeading: string;
  subtitle: string;
  tintByRegion: boolean;
  title: string;
};

function buildSeriesSheet(workbook: ExcelJS.Workbook, review: ClosingPerformanceReview, options: SeriesSheetOptions) {
  // The domain layer decides whether a row's units may be added. A units sheet built over rows that
  // say they cannot is exactly the mistake the rule exists to stop, so refuse rather than render it.
  if (options.measure === "units" && options.rows.some((row) => !row.unitsAreAddable)) {
    throw new Error(
      "Refusing to build a units sheet over rows that span more than one product: units of different products are never added.",
    );
  }

  const sheet = workbook.addWorksheet(options.name, {
    pageSetup: PAGE,
    views: [{ showGridLines: false, state: "frozen", xSplit: 2, ySplit: 9 }],
  });
  sheet.columns = [
    { width: 42 },
    { width: 24 },
    ...review.months.map(() => ({ width: 14 })),
    { width: 13 },
  ];
  const LAST = 2 + review.months.length + 1;

  masthead(workbook, sheet, {
    legend: "growth",
    lastCol: LAST,
    note: options.note,
    status: `source: Monthly Closing ${DOT} ${seriesSpanLabel(review)}`,
    subtitle: options.subtitle,
    title: options.title,
  });

  let row = 9;
  headerRow(
    sheet,
    row,
    [options.rowHeading, options.subHeading, ...review.months.map(shortMonthLabel), "GROWTH"],
    2,
  );
  row += 1;

  const firstBodyRow = row;
  options.rows.forEach((entry, index) => {
    const style = options.tintByRegion ? performanceReviewRegionStyle(regionCodeFor(review, entry)) : null;
    sheet.getRow(row).height = 16;
    const cells = bodyRow(sheet, row, LAST, { zebra: index % 2 === 1 });
    cells[0].value = entry.label;
    align(font(cells[0], { color: { argb: INK }, name: HOUSE_XLSX_FONT, size: 9.5 }), { horizontal: "left", indent: 1 });
    cells[1].value = entry.subLabel;
    align(font(cells[1], { bold: Boolean(style), color: { argb: style ? style.chip : SLATE }, name: HOUSE_XLSX_FONT, size: 8.5 }), { horizontal: "left", indent: 1 });
    entry.perMonth.forEach((value, monthIndex) => {
      money(cells[2 + monthIndex], value, { na: value == null });
    });
    growth(cells[LAST - 1], entry.growth);
    row += 1;
  });

  // Column totals. Only meaningful in value — a units column across different products is not a
  // quantity, so the units sheet deliberately carries no total row.
  if (options.measure === "value") {
    sheet.getRow(row).height = 20;
    for (let column = 1; column <= LAST; column += 1) {
      border(sheet.getCell(row, column), { b: medB, t: medB });
    }
    sheet.mergeCells(row, 1, row, 2);
    align(font(sheet.getCell(row, 1), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 10 }), {
      horizontal: "left",
      indent: 1,
      vertical: "middle",
    }).value = "TOTAL";
    const totals = review.months.map((_, monthIndex) => {
      const present = options.rows.map((entry) => entry.perMonth[monthIndex]).filter((value): value is number => value != null);
      return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
    });
    totals.forEach((value, monthIndex) => {
      money(sheet.getCell(row, 3 + monthIndex), value, { bold: true, color: DEEP, na: value == null });
    });
    growth(sheet.getCell(row, LAST), reviewGrowthOf(totals));
  }

  if (options.rows.length > 0) {
    sheet.autoFilter = { from: { column: 1, row: 9 }, to: { column: LAST, row: firstBodyRow + options.rows.length - 1 } };
  }
}

// ── Sheet 8 — the per-rep by-month units grid ────────────────────────────────

/**
 * Reps and areas down the side, one PRODUCT per block across the top, its months inside the block.
 *
 * The owner's shape for this sheet: the product name MERGES over its own run of months plus that
 * product's growth, then the next product's block begins. Frozen at the fourth column and under the
 * header, so the names stay on screen however far right the products run — on a fifteen-product line
 * with six months that is ninety-odd columns.
 *
 * Every figure is UNITS, and they are a real quantity because a block is one product code: they may
 * be read across the months and summed down the column, which is why the region subtotals and the
 * national total are legitimate here. There is deliberately NO row total — a row spans products, and
 * units of different products are never added.
 */
function buildProductMonthSheet(
  workbook: ExcelJS.Workbook,
  review: ClosingPerformanceReview,
  options: { grid: PerformanceProductMonthMatrix; name: string; note: string; subtitle: string; title: string },
) {
  const { grid } = options;
  // The domain layer decides whether a block's units may be added. A units sheet built over columns
  // that say they cannot is exactly the mistake the rule exists to stop, so refuse to render it.
  if (grid.columns.some((column) => !column.unitsAreAddable)) {
    throw new Error(
      "Refusing to build a units grid whose columns span more than one product: units of different products are never added.",
    );
  }

  const NAMES = 4;
  const PER_PRODUCT = grid.months.length + 1;
  const LAST = NAMES + grid.columns.length * PER_PRODUCT;
  const sheet = workbook.addWorksheet(options.name, {
    pageSetup: PAGE,
    views: [{ showGridLines: false, state: "frozen", xSplit: NAMES, ySplit: 10 }],
  });
  sheet.columns = [
    { width: 34 }, { width: 26 }, { width: 30 }, { width: 15 },
    ...grid.columns.flatMap(() => [...grid.months.map(() => ({ width: 12 })), { width: 13 }]),
  ];

  masthead(workbook, sheet, {
    legend: "regions",
    lastCol: LAST,
    note: options.note,
    status: `source: Monthly Closing ${DOT} ${seriesSpanLabel(review)} ${DOT} ${grid.columns.length} products ${DOT} ${grid.rows.filter((row) => row.kind === "area").length} areas`,
    subtitle: options.subtitle,
    title: options.title,
  });

  // Band row: one merged cell per product, over that product's own months and its growth column.
  let row = 9;
  sheet.getRow(row).height = 18;
  for (let column = 1; column <= LAST; column += 1) {
    border(sheet.getCell(row, column), { b: med, t: medB });
  }
  sheet.mergeCells(row, 1, row, NAMES);
  align(font(sheet.getCell(row, 1), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 8.5 }), {
    horizontal: "left",
    indent: 1,
    vertical: "middle",
  }).value = "WHO SOLD IT";
  grid.columns.forEach((column, index) => {
    const from = NAMES + index * PER_PRODUCT + 1;
    const to = from + PER_PRODUCT - 1;
    if (to > from) sheet.mergeCells(row, from, row, to);
    align(font(sheet.getCell(row, from), { bold: true, color: { argb: DEEP }, name: HOUSE_XLSX_FONT, size: 8.5 }), {
      horizontal: "center",
      vertical: "middle",
    }).value = column.label;
  });
  row += 1;

  headerRow(
    sheet,
    row,
    [
      "REP",
      "AREA",
      "DISTRICT MANAGER",
      "REGION",
      ...grid.columns.flatMap(() => [...grid.months.map(shortMonthLabel), "GROWTH"]),
    ],
    NAMES,
  );
  row += 1;

  const firstBodyRow = row;
  let zebra = false;
  for (const entry of grid.rows) {
    const isTotal = entry.kind !== "area";
    const style = performanceReviewRegionStyle(entry.regionCode);
    if (entry.kind === "area") zebra = !zebra;
    sheet.getRow(row).height = isTotal ? 19 : 16;
    const cells = bodyRow(sheet, row, LAST, {
      emphasis: entry.kind === "grandTotal" ? "total" : entry.kind === "regionSubtotal" ? "subtotal" : "area",
      zebra,
    });

    const ink = isTotal ? DEEP : INK;
    const label = (cell: Cell, value: string, muted = false) => {
      cell.value = value;
      align(
        font(cell, {
          bold: isTotal,
          color: { argb: isTotal ? DEEP : muted ? MUTE : INK },
          italic: muted,
          name: HOUSE_XLSX_FONT,
          size: isTotal ? 9.5 : 9,
        }),
        { horizontal: "left", indent: 1 },
      );
    };

    if (entry.kind === "area") {
      // "Vacant seat" is a real fact about a real seat; a dash is an area the organogram carries no
      // seat for at all. Neither is a system state, and neither may become one.
      if (entry.repName) label(cells[0], entry.repName);
      else if (entry.repIsVacant) label(cells[0], "Vacant seat", true);
      else label(cells[0], EM, true);
      label(cells[1], entry.areaName);
      label(cells[2], entry.managerName ?? EM, entry.managerName == null);
      cells[3].value = entry.regionName;
      align(font(cells[3], { bold: true, color: { argb: style.chip }, name: HOUSE_XLSX_FONT, size: 8.5 }), {
        horizontal: "left",
        indent: 1,
      });
    } else {
      label(
        cells[0],
        entry.kind === "grandTotal"
          ? reviewTotalRowLabel(review).toUpperCase()
          : `${entry.regionName.toUpperCase()} TOTAL`,
      );
      for (const index of [1, 2, 3]) {
        cells[index].value = "";
        font(cells[index], { color: { argb: ink }, name: HOUSE_XLSX_FONT, size: 9 });
      }
    }

    grid.columns.forEach((_, productIndex) => {
      const base = NAMES + productIndex * PER_PRODUCT;
      grid.months.forEach((_month, monthIndex) => {
        const value = entry.units[productIndex]?.[monthIndex] ?? null;
        money(cells[base + monthIndex], value, { bold: isTotal, color: ink, na: value == null });
      });
      growth(cells[base + grid.months.length], entry.growth[productIndex] ?? null);
    });
    row += 1;
  }

  if (grid.rows.length > 0) {
    sheet.autoFilter = { from: { column: 1, row: 10 }, to: { column: LAST, row: firstBodyRow + grid.rows.length - 1 } };
  }
}

/**
 * The region a series row belongs to, so the area sheet is tinted like every other sheet.
 *
 * An area that sold in an earlier month but not the selected one is absent from `review.areas`, so
 * the row's own region NAME is the fallback — that row still belongs on the page, in its colour.
 * That fallback reads THIS line's own region list before the shared palette, because a line can name
 * a region something the palette does not carry: Anti Infective splits Upper Egypt into "Upper Egypt
 * 1" and "Upper Egypt 2", and only the line's list knows which code each of those names holds.
 */
function regionCodeFor(review: ClosingPerformanceReview, entry: PerformanceReviewSeriesRow): string {
  const area = review.areas.find((row) => row.areaCode.trim().toUpperCase() === entry.key);
  if (area) return area.regionCode;
  const subLabel = entry.subLabel.trim();
  const onThisLine = review.regions.find((region) => region.regionName === subLabel);
  if (onThisLine) return onThisLine.regionCode;
  const named = PERFORMANCE_REVIEW_REGIONS.find((region) => region.regionName === subLabel);
  return named?.regionCode ?? "";
}

/** Build the whole Performance Review workbook for one (line, period). */
export async function buildClosingPerformanceReviewWorkbook(review: ClosingPerformanceReview): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = `Sato Pharma ${DOT} Phoenix Workforce`;
  workbook.created = new Date(review.generatedAt);

  // The grids come first: this is the shape the owner reads the review in — who is on the left,
  // what they sold across the top. Everything after them is a different cut of the same numbers.
  buildGridSheet(workbook, review, {
    grid: review.matrixByFamily,
    measure: "value",
    name: "Reps " + DOT + " Families",
    note: "a family spans several concentrations, so a family cell is VALUE: units of different products are never added",
    subtitle: withScope(review, `${review.line ?? EM} ${DOT} ${headlinePeriodLabel(review)} ${DOT} value per family`),
    title: "REPS AND AREAS " + DOT + " FAMILIES",
  });

  buildGridSheet(workbook, review, {
    grid: review.matrixByProduct,
    measure: "units",
    name: "Reps " + DOT + " Products",
    note: "every column here is ONE product code, so these units are a real quantity; the row total is VALUE, because a row spans products",
    subtitle: withScope(review, `${review.line ?? EM} ${DOT} ${headlinePeriodLabel(review)} ${DOT} units per product code`),
    title: "REPS AND AREAS " + DOT + " PRODUCTS",
  });

  buildRepRankingSheet(workbook, review);
  buildFamilySheet(workbook, review);

  buildSeriesSheet(workbook, review, {
    measure: "units",
    name: "Units & Growth by Month",
    note: "every row here is ONE product code, so these units are a real quantity and may be compared month to month",
    rowHeading: "PRODUCT",
    rows: review.productUnitsByMonth,
    subHeading: "FAMILY",
    subtitle: withScope(review, `${review.line ?? EM} ${DOT} units per product code ${DOT} ${seriesSpanLabel(review)}`),
    tintByRegion: false,
    title: "UNITS & GROWTH BY MONTH",
  });

  buildSeriesSheet(workbook, review, {
    measure: "value",
    name: "All Products by Month",
    note: "value, so products of different concentrations can be compared and added",
    rowHeading: "PRODUCT",
    rows: review.productValueByMonth,
    subHeading: "FAMILY",
    subtitle: withScope(review, `${review.line ?? EM} ${DOT} value per product code ${DOT} ${seriesSpanLabel(review)}`),
    tintByRegion: false,
    title: "ALL PRODUCTS BY MONTH",
  });

  buildSeriesSheet(workbook, review, {
    measure: "value",
    name: "Growth by Month " + DOT + " Area",
    note: "an area sells the whole line, so it is measured by VALUE: units of different products are never added",
    rowHeading: "AREA",
    rows: review.areaValueByMonth,
    subHeading: "REGION",
    subtitle: withScope(review, `${review.line ?? EM} ${DOT} value per area ${DOT} ${seriesSpanLabel(review)}`),
    tintByRegion: true,
    title: "GROWTH BY MONTH " + DOT + " AREA",
  });

  buildProductMonthSheet(workbook, review, {
    grid: review.productUnitsByRepByMonth,
    name: "Reps " + DOT + " Products by Month",
    note: "each block is ONE product code, so these units are a real quantity; there is no row total, because a row spans products",
    subtitle: withScope(
      review,
      `${review.line ?? EM} ${DOT} units per product code, per rep ${DOT} ${seriesSpanLabel(review)}`,
    ),
    title: "REPS AND AREAS " + DOT + " PRODUCTS BY MONTH",
  });

  // Not protected: every tab, hidden ones included, opens for editing (owner, 2026-10-26).

  unprotectExcelWorkbook(workbook);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
