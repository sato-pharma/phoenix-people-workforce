/**
 * The house identity, applied to a payroll sheet.
 *
 * WHY THIS IS ITS OWN MODULE. Four different files render the same payroll columns — the monthly
 * run sheet, the finance download that wraps it, the salary batch download, and the payslip
 * renderer — and until now each carried its own idea of what the sheet looks like: the run sheet in
 * Phoenix black and orange, the upload template in a private purple/green/red palette, the batch
 * download in one orange header row and nothing else. Three renderings of one document, agreeing
 * about nothing except the column names.
 *
 * Everything here derives from `house-xlsx-identity.ts`, which derives from `HOUSE_COLORS`. Nothing
 * re-types a colour.
 *
 * ── THE SECTION BANDS MUST BE COMPUTED, NEVER COPIED ───────────────────────────────────────────
 *
 * `payrollSheetSections` describes bands as absolute column numbers over the FULL 37-column header
 * list. The run sheet does not always write all 37: the Part-1 sheet passes a subset, and callers
 * append their own extra columns after it. Painting the absolute band positions onto a subset would
 * put "Governmental Deductions" over whatever happens to sit in columns 23-25 of that subset, which
 * is a caption confidently naming the wrong money.
 *
 * So `resolvePayrollBands` maps each header BACK to its own section through
 * `payrollSheetSectionForIndex` and then groups neighbours that share one. It is correct for the
 * full sheet, for any subset, and for a subset that reorders — and it cannot silently drift when a
 * column is inserted, because it never assumes a position.
 *
 * ── ONE DELIBERATE DEPARTURE: COLOUR IS NOT THE ONLY HELD SIGNAL ───────────────────────────────
 *
 * A held row used to be marked by a red fill and red text, and by nothing else. That is the single
 * most consequential fact on the sheet — `publishToPayslips` filters `!onHold`, so a held row is
 * dropped at publish, no salary_record is written, and nothing anywhere records that the person was
 * paid outside the system — and it was carried entirely by colour. Colour does not survive
 * greyscale printing, a range copied into another workbook, or a reader who cannot distinguish it.
 * The tint is gone; the row now carries weight, a flag-coloured type, a thick rule down its leading
 * edge, and a cell note spelling out what "held" costs. The cover names each held person outright,
 * so the fact exists in words somewhere no styling can lose.
 */

import type ExcelJS from "exceljs";

import { HOUSE_XLSX_COLORS, writeHouseMasthead } from "@/lib/export/house-xlsx-identity";
import {
  isPayrollNumericHeader,
  payrollSheetHeaders,
  payrollSheetSectionForIndex,
  type PayrollSheetHeader,
} from "@/lib/payroll/salary-sheet-fields";

/**
 * Row plan. These are the positions the sheet already used — `bandHeader` occupied rows 1-2 and the
 * header sat at 5, leaving 3 and 4 unused — so adopting the house masthead and adding the section
 * band shifts NOTHING. The tests that read these sheets find the header by searching for "Full
 * Name" rather than by row number, but a shift would still have moved every cached row reference in
 * the payslip renderer.
 */
export const PAYROLL_SECTION_ROW = 4;
export const PAYROLL_HEADER_ROW = 5;
export const PAYROLL_FIRST_DATA_ROW = 6;

export type PayrollBand = {
  label: string;
  /** 1-based column number in the sheet as actually written. */
  from: number;
  to: number;
};

/**
 * The section bands for the columns this sheet actually writes.
 *
 * `extraLabels` are the caller's appended columns (finance edit fields, bank details). They are not
 * part of any payroll section, so they get their own band rather than being folded into the last
 * real one — captioning a finance note as "Payment Split" would be worse than captioning it as
 * nothing.
 */
export function resolvePayrollBands(
  headers: readonly PayrollSheetHeader[],
  extraLabels: readonly string[] = [],
): PayrollBand[] {
  const bands: PayrollBand[] = [];

  headers.forEach((header, index) => {
    const canonicalIndex = payrollSheetHeaders.indexOf(header);
    // A header the canonical list does not know cannot be placed; give it no caption rather than
    // guessing at one.
    const label = canonicalIndex < 0 ? "" : payrollSheetSectionForIndex(canonicalIndex).label;
    const column = index + 1;
    const previous = bands[bands.length - 1];
    if (previous && previous.label === label && previous.to === column - 1) previous.to = column;
    else bands.push({ from: column, label, to: column });
  });

  if (extraLabels.length > 0) {
    bands.push({
      from: headers.length + 1,
      label: "Added for this download",
      to: headers.length + extraLabels.length,
    });
  }

  return bands;
}

/**
 * Writes the section band.
 *
 * Every band is the same blue: the palette is three blues and black, and six sections cannot each
 * have a hue without inventing colours the mark does not contain. What separates them is the RULE
 * at each boundary, which is how the printed house format separates anything.
 */
export function writePayrollSectionBand(sheet: ExcelJS.Worksheet, bands: PayrollBand[]) {
  const row = sheet.getRow(PAYROLL_SECTION_ROW);
  row.height = 15;

  for (const band of bands) {
    for (let column = band.from; column <= band.to; column += 1) {
      const cell = row.getCell(column);
      cell.value = column === band.from ? band.label.toUpperCase() : null;
      cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.light }, name: "Aptos", size: 7.5 };
      cell.alignment = { horizontal: "left", vertical: "bottom" };
      cell.border =
        column === band.from
          ? { left: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.blue } } }
          : {};
    }
  }
}

/** Header cell: deep bold type on white under a Brand Blue rule. Never a filled band. */
export function payrollHeaderCell(
  cell: ExcelJS.Cell,
  options: { execution?: boolean; numeric?: boolean } = {},
) {
  cell.font = {
    bold: true,
    color: { argb: HOUSE_XLSX_COLORS.deep },
    name: "Aptos",
    size: 9.5,
  };
  cell.alignment = {
    horizontal: options.numeric ? "right" : "left",
    vertical: "bottom",
    wrapText: true,
  };
  cell.border = {
    bottom: { style: options.execution ? "thick" : "medium", color: { argb: HOUSE_XLSX_COLORS.blue } },
    top: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } },
  };
}

export type PayrollBodyOptions = {
  zebra: boolean;
  header?: PayrollSheetHeader;
  numeric?: boolean;
  /** The row is on hold: not paid by this run, and dropped entirely at publish. */
  held: boolean;
  /** The First Part column — the amount finance actually executes this run. */
  execution?: boolean;
  /** First column of the row, which carries the held row's leading rule. */
  leading?: boolean;
};

/** Body cell. The zebra is the only fill in the format, exactly as the approved specimen has it. */
export function payrollBodyCell(cell: ExcelJS.Cell, options: PayrollBodyOptions) {
  const numeric = options.numeric ?? (options.header ? isPayrollNumericHeader(options.header) : false);

  cell.font = {
    bold: options.held || options.execution,
    color: { argb: options.held ? HOUSE_XLSX_COLORS.flag : HOUSE_XLSX_COLORS.body },
    name: "Aptos",
    size: 9.5,
  };
  cell.alignment = { horizontal: numeric ? "right" : "left", vertical: "middle" };

  const border: Partial<ExcelJS.Borders> = options.zebra
    ? {}
    : { bottom: { style: "hair", color: { argb: HOUSE_XLSX_COLORS.hair } } };

  // A held row carries a thick leading rule — the one held signal that survives greyscale.
  if (options.held && options.leading) {
    border.left = { style: "thick", color: { argb: HOUSE_XLSX_COLORS.flag } };
  }
  // The execution column is bracketed by rules rather than filled, so it reads as a column even
  // when the row beside it is held.
  if (options.execution) {
    border.left = { style: "thin", color: { argb: HOUSE_XLSX_COLORS.blue } };
    border.right = { style: "thin", color: { argb: HOUSE_XLSX_COLORS.blue } };
  }
  cell.border = border;

  if (options.zebra && !options.held) {
    cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
  }
}

/**
 * What a held row means, in words, on the row itself.
 *
 * Attached to the row's identifying cell as a note so the fact travels with the row rather than
 * living only in a legend the reader has to go and find.
 */
export const HELD_ROW_NOTE =
  "HELD — this person is NOT paid by this run. A held row is dropped at publish: no salary record " +
  "is written and nothing here records a payment made outside the system. Held means the SECOND " +
  "part is owed, not the whole month — paying full net would pay part one twice.";

/** Totals row: heavier type under a double rule, no fill. */
export function payrollTotalsCell(cell: ExcelJS.Cell, options: { numeric?: boolean } = {}) {
  cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 };
  cell.alignment = { horizontal: options.numeric ? "right" : "left", vertical: "middle" };
  cell.border = {
    bottom: { style: "double", color: { argb: HOUSE_XLSX_COLORS.blue } },
    top: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.blue } },
  };
}

export type PayrollCoverInput = {
  title: string;
  subtitle: string;
  /** Key/value provenance rows — period, scope, counts, and the named held people. */
  rows: Array<[string, string]>;
  confidentialNote: string;
};

/**
 * The payroll cover, in the house format.
 *
 * Replaces `buildCoverSheet`'s black-and-orange band. The confidentiality line is a CALLOUT — a
 * rule down its leading edge and type — rather than the amber block it used to be, because a
 * payroll pack is printed and the ink rule is what that format is for.
 *
 * A row whose key begins "Held" is given the flag colour: those are the people this run does NOT
 * pay, and on a cover full of counts they must not read like one more statistic.
 */
export function buildPayrollCoverSheet(workbook: ExcelJS.Workbook, cover: PayrollCoverInput) {
  const sheet = workbook.addWorksheet("Cover", { properties: { defaultRowHeight: 18 } });
  sheet.views = [{ showGridLines: false }];
  sheet.getColumn(1).width = 4;
  sheet.getColumn(2).width = 32;
  sheet.getColumn(3).width = 96;

  writeHouseMasthead(workbook, sheet, {
    columns: 3,
    provenance: [cover.subtitle],
    subtitle: cover.subtitle,
    title: cover.title,
  });

  let row = 5;

  sheet.mergeCells(row, 2, row, 3);
  const note = sheet.getCell(row, 2);
  note.value = cover.confidentialNote;
  note.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 9.5 };
  note.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  note.border = { left: { style: "thick", color: { argb: HOUSE_XLSX_COLORS.light } } };
  sheet.getRow(row).height = 24;
  row += 2;

  const heading = sheet.getCell(row, 2);
  heading.value = "Report provenance";
  heading.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 11 };
  heading.border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
  sheet.getCell(row, 3).border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
  row += 1;

  cover.rows.forEach(([key, value], index) => {
    const held = key.startsWith("Held");
    const zebra = index % 2 === 1;
    const keyCell = sheet.getCell(row, 2);
    keyCell.value = key;
    keyCell.font = {
      bold: true,
      color: { argb: held ? HOUSE_XLSX_COLORS.flag : HOUSE_XLSX_COLORS.body },
      name: "Aptos",
      size: 9.5,
    };
    keyCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };

    const valueCell = sheet.getCell(row, 3);
    valueCell.value = value;
    valueCell.font = {
      bold: held,
      color: { argb: held ? HOUSE_XLSX_COLORS.flag : HOUSE_XLSX_COLORS.body },
      name: "Aptos",
      size: 9.5,
    };
    valueCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };

    if (zebra && !held) {
      for (const cell of [keyCell, valueCell]) {
        cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
      }
    }
    sheet.getRow(row).height = Math.max(17, Math.ceil(value.length / 95) * 13 + 5);
    row += 1;
  });

  return sheet;
}

/** The house masthead for the workbook's secondary sheets (summaries), replacing the black band. */
export function writePayrollSheetMasthead(
  workbook: ExcelJS.Workbook,
  sheet: ExcelJS.Worksheet,
  input: { columns: number; subtitle: string; title: string },
) {
  sheet.views = [{ showGridLines: false }];
  writeHouseMasthead(workbook, sheet, {
    columns: input.columns,
    provenance: [input.subtitle],
    subtitle: input.subtitle,
    title: input.title,
  });
}
