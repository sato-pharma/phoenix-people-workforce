/**
 * The SATO house document identity, expressed for spreadsheets — SATO-DIS-2026-01 v1.0.
 *
 * WHY THIS EXISTS. `src/lib/hiring-pack/house-identity.ts` carries the identity as CSS, for the
 * documents that get printed. It says, in its own opening comment, that an identity living in five
 * places is five identities that happen to agree today. A workbook cannot import CSS, so the risk
 * here is exactly that: a sixth copy of the palette, typed by hand, drifting the first time one of
 * the blues is re-sampled.
 *
 * So nothing in this file re-types a colour. Every value below is DERIVED from `HOUSE_COLORS` at
 * module load, converted from `#RRGGBB` to the `AARRGGBB` that OOXML wants. Re-sample the logo,
 * change that one module, and the workbooks follow.
 *
 * WHAT CHANGES FOR SCREEN. The ink rule — colour carried by lines and type, never by filled area —
 * exists because contracts print in volume on office machines. A workbook is read on screen, where
 * filled area costs no toner but still reads as heavier than it needs to be, and the owner's
 * approved specimen is what people now recognise as a company document. So the rule is kept, for
 * looks rather than for toner: headers are TYPE ON WHITE UNDER A RULE, not a filled band, and the
 * one filled element is the same 6% zebra the owner asked for by name.
 *
 * THE ONE COLOUR THAT IS NOT IN THE PALETTE is `flag` — the house palette is four blues and black,
 * and none of them can say "this cell is wrong". It is used for defect text and nowhere else, it is
 * never a fill, and it is deliberately a dark red rather than a signal red so that it sits beside
 * the blues instead of shouting over them.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type ExcelJS from "exceljs";

import { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_COLORS, toArgb } from "@/lib/export/house-xlsx-palette";

// Re-exported so every caller that only wants a colour keeps its existing import, and so this
// module stays the single name to reach for when a builder wants the masthead AS WELL.
// A client-reachable module must import "@/lib/export/house-xlsx-palette" DIRECTLY: this file
// reads the wordmark off disk, and node:fs fails a Turbopack client build outright.
export { HOUSE_DOCUMENT_STANDARD, HOUSE_XLSX_COLORS, toArgb };


/**
 * The mark, relative to the app root.
 *
 * ALWAYS THE ON-LIGHT FILE. The stock mark sets "SATO" in WHITE for dark grounds; a workbook has no
 * dark grounds, so the stock file would put the company's own name in white on a white sheet and the
 * masthead would read "PHARMA". That has already reached printed output once.
 *
 * PNG, NOT THE SVG that `house-identity.ts` points at. A browser renders the vector; ExcelJS accepts
 * png/jpeg/gif only and hands anything else through to a part Excel then silently repairs.
 */
export const HOUSE_MARK_XLSX_PATH = path.join("public", "brand", "sato-pharma-logo-on-light.png");

/** The mark as base64, or null when the asset is missing — a workbook must still build without it. */
export function readHouseMark(): string | null {
  try {
    return readFileSync(path.join(process.cwd(), HOUSE_MARK_XLSX_PATH)).toString("base64");
  } catch {
    return null;
  }
}

/**
 * The mark's image id for a workbook, added at most ONCE.
 *
 * `workbook.addImage` appends a fresh copy of the bytes every time it is called, and it returns a
 * different id each time — so a workbook with a masthead on six sheets embedded the same 28KB PNG
 * six times. Measured on the payroll pack: four sheets took the file from 43KB to 103KB, and none
 * of the extra 60KB was information. Keyed off the workbook itself so the cache cannot outlive it.
 */
/**
 * When a house document was generated, in Cairo — "05 Sep 2026, 12:00 PM (Cairo)".
 *
 * EVERY HOUSE COVER PRINTED A RAW UTC ISO STRING until 2026-09-05: `2026-09-05T09:00:00.000Z`,
 * under the label "Generated (UTC)". Two things wrong with that, and the second is the one that
 * costs something. It is not a time anybody reads — the owner's standing rule is Africa/Cairo,
 * human-readable, everywhere. And it is three hours out: a reader comparing an export against the
 * hour they asked for it sees a file apparently produced before they clicked.
 *
 * THIS IS THE ONE TIMESTAMP CLASS THAT BELONGS IN CAIRO, and the distinction matters because two
 * neighbouring classes do NOT. A DATE-ONLY value — a period key, a hire date, a window bound —
 * parses as UTC midnight and must be RENDERED in UTC, or the calendar day shifts. A vendor
 * wall-clock (iReports360's `crm_save_date`) is already Cairo and converting it prints it hours
 * late. Only an instant WE stamped with `new Date().toISOString()` should be converted, and that is
 * exactly what `generatedAtIso` is. Classify by the backing value, never by the formatter's name.
 *
 * Returns the input unchanged when it is not a parseable instant: a cover that cannot say when it
 * was made should show what it was given, not the words "Invalid Date".
 */
const HOUSE_GENERATED_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit", month: "short", timeZone: "Africa/Cairo", year: "numeric",
});
const HOUSE_GENERATED_TIME = new Intl.DateTimeFormat("en-US", {
  hour: "numeric", hour12: true, minute: "2-digit", timeZone: "Africa/Cairo",
});

export function houseGeneratedAt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${HOUSE_GENERATED_DATE.format(at)}, ${HOUSE_GENERATED_TIME.format(at)} (Cairo)`;
}

/**
 * The cover's generated-at row, label included.
 *
 * A ROW RATHER THAN A BARE FORMATTER, because the label was half the defect: seven covers said
 * "Generated (UTC)" and would have kept saying it beside a Cairo time. Handing back both means a
 * caller cannot update one and forget the other.
 */
export function houseGeneratedRow(iso: string): [string, string] {
  return ["Generated", houseGeneratedAt(iso)];
}

const houseMarkIdByWorkbook = new WeakMap<ExcelJS.Workbook, number | null>();

function houseMarkImageId(workbook: ExcelJS.Workbook): number | null {
  const cached = houseMarkIdByWorkbook.get(workbook);
  if (cached !== undefined) return cached;
  const mark = readHouseMark();
  const id = mark === null ? null : workbook.addImage({ base64: mark, extension: "png" });
  houseMarkIdByWorkbook.set(workbook, id);
  return id;
}

export type HouseMastheadInput = {
  /** Document title, e.g. "Employee Master". */
  title: string;
  /** One line under the title: what this is and who it is for. */
  subtitle: string;
  /** Right-hand provenance lines — generated-at, scope, record count. */
  provenance: string[];
  /** How many columns the masthead spans. */
  columns: number;
};

/** The row the masthead ends on; every sheet's own content starts after it. */
export const HOUSE_MASTHEAD_ROWS = 3;

/**
 * Writes the house masthead into rows 1-3 and returns the next free row.
 *
 * THE LAYOUT IS THE APPROVED SPECIMEN'S, adapted to a grid: the mark sits physically left, the
 * provenance block sits right, and a Brand Blue rule runs the full width beneath them. On paper that
 * rule is what makes a page recognisable at arm's length; here it does the same job for a tab. It is
 * a RULE, not a band — one short row filled with Brand Blue — which is the single shape the ink rule
 * allows, and the reason this masthead spends about 1% of the ink the old filled navy band did.
 */
export function writeHouseMasthead(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  input: HouseMastheadInput,
): number {
  const { title, subtitle, provenance, columns } = input;
  const lastColumn = Math.max(columns, 4);
  const provenanceFirstColumn = Math.max(4, lastColumn - 2);
  const titleLastColumn = Math.max(3, provenanceFirstColumn - 1);

  // On a sheet narrower than the masthead, the provenance block lands in a column the sheet never
  // sized — it rendered at the default width and wrapped the document id onto four lines. Give any
  // column the masthead reaches, but the sheet did not claim, a width of its own.
  for (let column = 1; column <= lastColumn; column += 1) {
    const excelColumn = sheet.getColumn(column);
    if (!excelColumn.width) excelColumn.width = 22;
  }

  // Row 1 — the mark's row. Columns 1-2 are left clear for the floating image, and the title sits
  // BESIDE the mark rather than under it, so the lockup reads as one horizontal unit as it does on
  // the specimen.
  sheet.getRow(1).height = 34;
  sheet.mergeCells(1, 3, 1, titleLastColumn);
  const titleCell = sheet.getCell(1, 3);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos Display", size: 16 };
  titleCell.alignment = { horizontal: "left", vertical: "middle" };

  // The specimen's `.lh__id` block, right-aligned.
  sheet.mergeCells(1, provenanceFirstColumn, 1, lastColumn);
  const idCell = sheet.getCell(1, provenanceFirstColumn);
  idCell.value = [HOUSE_DOCUMENT_STANDARD, ...provenance].join("\n");
  idCell.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, name: "Aptos", size: 7.5 };
  idCell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };

  const imageId = houseMarkImageId(workbook);
  if (imageId !== null) {
    // 401x158 native, so 96x38 holds the 2.54:1 ratio and keeps the PHARMA counters open.
    sheet.addImage(imageId, { tl: { col: 0.2, row: 0.15 }, ext: { width: 96, height: 38 } });
  }

  // Row 2 — the subtitle, muted type, no fill.
  sheet.getRow(2).height = 15;
  sheet.mergeCells(2, 1, 2, lastColumn);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, name: "Aptos", size: 9 };
  subtitleCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };

  // Row 3 — the brand rule.
  const ruleRow = sheet.getRow(3);
  ruleRow.height = 3;
  for (let column = 1; column <= lastColumn; column += 1) {
    ruleRow.getCell(column).fill = {
      fgColor: { argb: HOUSE_XLSX_COLORS.blue },
      pattern: "solid",
      type: "pattern",
    };
  }

  return HOUSE_MASTHEAD_ROWS + 1;
}

/** The house table header: deep bold type on white under a Brand Blue rule. Never a filled band. */
export function houseHeaderStyle(cell: ExcelJS.Cell, options: { size?: number; center?: boolean } = {}) {
  cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: options.size ?? 10 };
  cell.alignment = {
    horizontal: options.center ? "center" : "left",
    vertical: "bottom",
    wrapText: true,
  };
  cell.border = {
    bottom: { style: "medium", color: { argb: HOUSE_XLSX_COLORS.blue } },
    top: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } },
  };
}

/**
 * Body type, with the hairline the zebra row REPLACES rather than joins.
 *
 * That substitution is the specimen's, not a shortcut: a tinted row already reads as a band, so
 * ruling it as well draws the eye twice for one row.
 */
export function houseBodyStyle(cell: ExcelJS.Cell, options: { zebra?: boolean; size?: number } = {}) {
  cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: options.size ?? 10 };
  cell.alignment = { vertical: "middle" };
  if (options.zebra) {
    cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
  } else {
    cell.border = { bottom: { style: "hair", color: { argb: HOUSE_XLSX_COLORS.hair } } };
  }
}

/**
 * A house callout: light type indented under a Brand Blue edge on the leading side.
 *
 * The specimen's callout is a rule plus type, never a tinted box — this is that shape in a grid.
 */
export function houseCalloutStyle(cell: ExcelJS.Cell, options: { emphasis?: boolean } = {}) {
  cell.font = {
    bold: Boolean(options.emphasis),
    color: { argb: options.emphasis ? HOUSE_XLSX_COLORS.deep : HOUSE_XLSX_COLORS.body },
    name: "Aptos",
    size: 10,
  };
  cell.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  cell.border = { left: { style: "thick", color: { argb: HOUSE_XLSX_COLORS.light } } };
}
