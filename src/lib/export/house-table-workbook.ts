/**
 * A report sheet in the house identity — the cover, and the table.
 *
 * WHY IT IS GENERIC. `buildCoverSheet` and `writeTable` in the Phoenix kit are used by a dozen
 * exports, and rewriting them in place would restyle every one of those at once, including several
 * nobody asked about. These are drop-in replacements with the same shapes, so an export moves onto
 * the house identity by changing its import and nothing else — and the ones still on the Phoenix
 * kit keep working exactly as they did.
 *
 * WHAT CHANGES, IN ONE SENTENCE: the black-and-orange bands become type under a Brand Blue rule,
 * the nine-colour tinting becomes one 6% zebra, and the amber totals band becomes weight under a
 * double rule. Nothing here re-types a colour; it all derives from `HOUSE_COLORS` through
 * `house-xlsx-identity`.
 */

import type ExcelJS from "exceljs";

import {
  HOUSE_XLSX_COLORS,
  writeHouseMasthead,
} from "@/lib/export/house-xlsx-identity";
import { setCell, type CellValue, type TableColumn } from "@/lib/sales/sales-workbook-kit";

export type { CellValue, TableColumn };

/**
 * A data bar in Brand Blue.
 *
 * The kit's own bar is Phoenix orange. Wrapped in try/catch for the same reason the original is:
 * ExcelJS throws on a data bar over a range it cannot resolve, and a decorative bar is never worth
 * failing an export for.
 */
export function applyHouseDataBar(sheet: ExcelJS.Worksheet, ref: string, priority = 1) {
  try {
    sheet.addConditionalFormatting({
      ref,
      rules: [
        {
          cfvo: [{ type: "min" as const }, { type: "max" as const }],
          color: { argb: HOUSE_XLSX_COLORS.light },
          gradient: false,
          priority,
          showValue: true,
          type: "dataBar" as const,
        },
      ],
    });
  } catch {
    // A data bar is decoration; an export that fails because of one is worse than one without it.
  }
}

export type HouseCoverInput = {
  title: string;
  subtitle: string;
  /** Key/value provenance rows — period, scope, filters, counts. */
  rows: Array<[string, string]>;
  confidentialNote: string;
  /** Defaults to "Cover". */
  sheetName?: string;
  /**
   * Keys matching this are rendered in the flag colour — for facts that must not read as one more
   * statistic on a page of counts. Payroll uses it to name people this run does not pay.
   */
  emphasise?: (key: string) => boolean;
};

/** The cover: masthead, a confidentiality callout, and a provenance table. */
export function buildHouseCoverSheet(workbook: ExcelJS.Workbook, cover: HouseCoverInput) {
  const sheet = workbook.addWorksheet(cover.sheetName ?? "Cover", {
    properties: { defaultRowHeight: 18 },
  });
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

  // The confidentiality line as a CALLOUT — a rule down its leading edge and type — rather than the
  // amber block it used to be. These packs get printed, and the ink rule is what that format is for.
  sheet.mergeCells(row, 2, row, 3);
  const note = sheet.getCell(row, 2);
  note.value = cover.confidentialNote;
  note.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 9.5 };
  note.alignment = { horizontal: "left", indent: 1, vertical: "middle", wrapText: true };
  note.border = { left: { style: "thick", color: { argb: HOUSE_XLSX_COLORS.light } } };
  sheet.getRow(row).height = 24;
  row += 2;

  sheet.mergeCells(row, 2, row, 3);
  const heading = sheet.getCell(row, 2);
  heading.value = "Report provenance";
  heading.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 11 };
  heading.border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
  sheet.getCell(row, 3).border = { bottom: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } } };
  row += 1;

  cover.rows.forEach(([key, value], index) => {
    const flagged = cover.emphasise?.(key) ?? false;
    const zebra = index % 2 === 1;
    const colour = flagged ? HOUSE_XLSX_COLORS.flag : HOUSE_XLSX_COLORS.body;

    const keyCell = sheet.getCell(row, 2);
    keyCell.value = key;
    keyCell.font = { bold: true, color: { argb: colour }, name: "Aptos", size: 9.5 };
    keyCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };

    const valueCell = sheet.getCell(row, 3);
    valueCell.value = value;
    valueCell.font = { bold: flagged, color: { argb: colour }, name: "Aptos", size: 9.5 };
    valueCell.alignment = { horizontal: "left", vertical: "top", wrapText: true };

    if (zebra && !flagged) {
      for (const cell of [keyCell, valueCell]) {
        cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
      }
    }
    sheet.getRow(row).height = Math.max(17, Math.ceil(value.length / 95) * 13 + 5);
    row += 1;
  });

  return sheet;
}

function setColumnWidth(sheet: ExcelJS.Worksheet, index: number, width: number) {
  const column = sheet.getColumn(index);
  column.width = Math.max(column.width ?? 9, width);
}

export type HouseTableInput = {
  columns: TableColumn[];
  rows: CellValue[][];
  title: string;
  totals?: CellValue[];
  note?: string;
};

/**
 * Writes a titled table starting at `startRow`, and returns the next free row.
 *
 * Same contract as the kit's `writeTable` — same arguments, same return — so an export swaps one
 * import and keeps its layout arithmetic. Only the styling differs.
 */
export function writeHouseTable(
  sheet: ExcelJS.Worksheet,
  startRow: number,
  options: HouseTableInput,
): number {
  const { columns, rows, title, totals, note } = options;
  const columnCount = Math.max(1, columns.length);
  let row = startRow;

  // The table's own title: deep type over a Brand Blue rule, not a black bar.
  sheet.mergeCells(row, 1, row, columnCount);
  const titleCell = sheet.getCell(row, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 11 };
  titleCell.alignment = { horizontal: "left", indent: 1, vertical: "middle" };
  titleCell.border = { bottom: { style: "medium", color: { argb: HOUSE_XLSX_COLORS.blue } } };
  sheet.getRow(row).height = 22;
  row += 1;

  const headerRow = sheet.getRow(row);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 9.5 };
    cell.alignment = {
      horizontal: column.right ? "right" : "left",
      vertical: "bottom",
      wrapText: true,
    };
    cell.border = {
      bottom: { style: "medium", color: { argb: HOUSE_XLSX_COLORS.blue } },
      top: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.hair } },
    };
    setColumnWidth(sheet, index + 1, column.width ?? Math.max(12, column.label.length + 2));
  });
  headerRow.height = 22;
  row += 1;

  const firstDataRow = row;
  rows.forEach((cells, rowIndex) => {
    const excelRow = sheet.getRow(row);
    const zebra = rowIndex % 2 === 1;
    columns.forEach((column, index) => {
      const cell = excelRow.getCell(index + 1);
      setCell(cell, cells[index], column.numFmt);
      cell.font = { color: { argb: HOUSE_XLSX_COLORS.body }, name: "Aptos", size: 9.5 };
      cell.alignment = {
        horizontal: column.right ? "right" : "left",
        indent: column.right ? 0 : 1,
        vertical: "middle",
        wrapText: !column.right,
      };
      if (zebra) {
        cell.fill = { fgColor: { argb: HOUSE_XLSX_COLORS.tint }, pattern: "solid", type: "pattern" };
      } else {
        cell.border = { bottom: { style: "hair", color: { argb: HOUSE_XLSX_COLORS.hair } } };
      }
    });
    row += 1;
  });
  const lastDataRow = row - 1;

  if (totals && rows.length > 0) {
    const totalRow = sheet.getRow(row);
    columns.forEach((column, index) => {
      const cell = totalRow.getCell(index + 1);
      setCell(cell, totals[index], column.numFmt);
      cell.font = { bold: true, color: { argb: HOUSE_XLSX_COLORS.deep }, name: "Aptos", size: 10 };
      cell.alignment = {
        horizontal: column.right ? "right" : "left",
        indent: column.right ? 0 : 1,
        vertical: "middle",
      };
      cell.border = {
        bottom: { style: "double", color: { argb: HOUSE_XLSX_COLORS.blue } },
        top: { style: "thin", color: { argb: HOUSE_XLSX_COLORS.blue } },
      };
    });
    row += 1;
  }

  if (lastDataRow >= firstDataRow) {
    columns.forEach((column, index) => {
      if (column.dataBar) {
        const letter = sheet.getColumn(index + 1).letter;
        applyHouseDataBar(sheet, `${letter}${firstDataRow}:${letter}${lastDataRow}`);
      }
    });
  }

  if (note) {
    const noteCell = sheet.getCell(row, 1);
    noteCell.value = note;
    noteCell.font = { color: { argb: HOUSE_XLSX_COLORS.muted }, italic: true, name: "Aptos", size: 9 };
    row += 1;
  }

  return row + 1;
}
