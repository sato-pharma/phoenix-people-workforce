import type ExcelJS from "exceljs";

export const NAVY_BLUE = "FF0F172A"; // Slate 900
export const PHOENIX_ORANGE = "FFF97316"; // Orange 500
export const LIGHT_GRAY = "FFF8FAFC"; // Slate 50
export const BORDER_GRAY = "FFCBD5E1"; // Slate 300
export const MONEY_FMT = "#,##0.00";

/**
 * Applies a premium look to a data row.
 * Adds light borders and a standard font.
 */
export function styleDataRow(row: ExcelJS.Row, isTotal: boolean = false) {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "Arial", size: 10, bold: isTotal };
    cell.border = {
      top: { style: "thin", color: { argb: BORDER_GRAY } },
      left: { style: "thin", color: { argb: BORDER_GRAY } },
      bottom: { style: "thin", color: { argb: BORDER_GRAY } },
      right: { style: "thin", color: { argb: BORDER_GRAY } },
    };
    if (isTotal) {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } }; // Slate 200
    }
  });
}

/**
 * Applies the premium header style to a header row.
 * Navy blue or Phoenix Orange background, white bold text, and borders.
 */
export function styleHeaderRow(row: ExcelJS.Row, colorArgb: string = PHOENIX_ORANGE) {
  row.height = 26;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: colorArgb } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "medium", color: { argb: colorArgb } },
      left: { style: "thin", color: { argb: "FFFFFFFF" } }, // white separators
      bottom: { style: "medium", color: { argb: colorArgb } },
      right: { style: "thin", color: { argb: "FFFFFFFF" } },
    };
  });
}

/**
 * Automatically sizes columns with a minimum width based on header length and a padding factor.
 * Should be called after headers are set.
 */
export function autoSizeColumns(sheet: ExcelJS.Worksheet) {
  sheet.columns.forEach((col) => {
    let maxLength = 0;
    col.eachCell?.({ includeEmpty: true }, (cell) => {
      const columnLength = cell.value ? cell.value.toString().length : 10;
      if (columnLength > maxLength) {
        maxLength = columnLength;
      }
    });
    // Set a max width to prevent gigantic columns if there's a long description
    col.width = Math.min(Math.max(maxLength + 4, 12), 40);
  });
}
