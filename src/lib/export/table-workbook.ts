import ExcelJS from "exceljs";

// Reusable, premium Phoenix-styled XLSX builder for any admin table.
// Visual language matches the on-screen admin rules: black header band (sidebar
// colour) with centred white labels, thin light-orange cell grid, zebra rows, and
// a bold TOTAL row that uses live SUM() formulas for numeric columns.

export type ExportColumn = {
  key: string;
  label: string;
  /** Right-align + include in the SUM() totals row. */
  numeric?: boolean;
  width?: number;
};

export type ExportRow = Record<string, string | number | null | undefined>;

export type BuildTableWorkbookInput = {
  title: string;
  subtitle?: string;
  sheetName?: string;
  columns: ExportColumn[];
  rows: ExportRow[];
};

const BLACK = "FF000000";
const ORANGE = "FFF97316";
const ORANGE_SOFT = "FFFFF7ED";
const ORANGE_LINE = "FFF8B56B";
const WHITE = "FFFFFFFF";
const SLATE = "FF334155";
const MUTED = "FF94A3B8";

function gridBorder(): ExcelJS.Borders {
  const side = { style: "thin" as const, color: { argb: ORANGE_LINE } };
  return { top: side, left: side, bottom: side, right: side } as ExcelJS.Borders;
}

function sanitizeSheetName(name: string | undefined) {
  const cleaned = (name ?? "Export").replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Export").slice(0, 31);
}

export async function buildPhoenixTableWorkbook(input: BuildTableWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(sanitizeSheetName(input.sheetName ?? input.title), {
    views: [{ state: "frozen", ySplit: 3 }],
  });

  const colCount = Math.max(1, input.columns.length);

  // Row 1 — title band (black with orange title)
  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = input.title;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: ORANGE } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  sheet.getRow(1).height = 30;

  // Row 2 — subtitle band
  sheet.mergeCells(2, 1, 2, colCount);
  const subCell = sheet.getCell(2, 1);
  subCell.value = input.subtitle ?? `Phoenix Workforce · exported ${new Date().toLocaleString("en-GB")}`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: MUTED } };
  subCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  sheet.getRow(2).height = 18;

  // Row 3 — header (black, centred, white, bold)
  const headerRow = sheet.getRow(3);
  input.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label;
    cell.font = { name: "Calibri", size: 11.5, bold: true, color: { argb: WHITE } };
    cell.alignment = { vertical: "middle", horizontal: "center" };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
    cell.border = gridBorder();
  });
  headerRow.height = 22;

  // Data rows
  const firstDataRow = 4;
  input.rows.forEach((row, r) => {
    const excelRow = sheet.getRow(firstDataRow + r);
    input.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      const raw = row[col.key];
      cell.value = raw === null || raw === undefined ? "" : raw;
      cell.font = { name: "Calibri", size: 10.5, color: { argb: SLATE } };
      cell.alignment = { vertical: "middle", horizontal: col.numeric ? "right" : "left", wrapText: false };
      cell.border = gridBorder();
      if (r % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
      }
    });
  });

  // TOTAL row with SUM() formulas for numeric columns (formulas if available)
  const numericColumns = input.columns.filter((col) => col.numeric);
  if (numericColumns.length > 0 && input.rows.length > 0) {
    const totalRowIndex = firstDataRow + input.rows.length;
    const totalRow = sheet.getRow(totalRowIndex);
    input.columns.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1);
      cell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: BLACK } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
      cell.border = gridBorder();
      if (i === 0) {
        cell.value = "TOTAL";
        cell.alignment = { vertical: "middle", horizontal: "left" };
      } else if (col.numeric) {
        const letter = sheet.getColumn(i + 1).letter;
        cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${firstDataRow + input.rows.length - 1})` };
        cell.alignment = { vertical: "middle", horizontal: "right" };
      }
    });
  }

  // Column widths
  input.columns.forEach((col, i) => {
    const longest = input.rows.reduce((max, row) => {
      const value = row[col.key];
      return Math.max(max, value === null || value === undefined ? 0 : String(value).length);
    }, col.label.length);
    sheet.getColumn(i + 1).width = col.width ?? Math.max(12, Math.min(46, longest + 4));
  });

  return await workbook.xlsx.writeBuffer();
}
