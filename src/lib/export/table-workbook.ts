import ExcelJS from "exceljs";

// The PALETTE module, never `house-xlsx-identity` — this file is imported by a client component
// (`personal-expense-workload-dashboard`) as well as by API routes, and the identity module
// reads the wordmark with node:fs, which fails a Turbopack client build outright.
import { HOUSE_XLSX_COLORS } from "@/lib/export/house-xlsx-palette";

// Reusable, premium Phoenix-styled XLSX builder for any admin table.
// Visual language matches the on-screen admin rules: black header band (sidebar
// colour) with centred white labels, thin light-orange cell grid, zebra rows, and
// a bold TOTAL row that uses live SUM() formulas for numeric columns.

export type ExportColumn = {
  key: string;
  label: string;
  /** Right-align + include in the SUM() totals row. */
  numeric?: boolean;
  /**
   * Force the cell to Excel's text format (`@`).
   *
   * A JS string already lands as a text cell, so the value is correct on open without
   * this. What it buys is durability: a digit-only string like `01012345678` is one
   * retype or one paste away from Excel deciding it is the number 1012345678 and eating
   * the leading zero. That is not hypothetical here — it is precisely how 124 of 175
   * rows in `employees.mobile_number` were damaged in the first place. Set it on any
   * column holding digits that are an identifier rather than a quantity.
   */
  text?: boolean;
  width?: number;
};

export type ExportRow = Record<string, string | number | null | undefined>;

export type BuildTableWorkbookInput = {
  title: string;
  subtitle?: string;
  sheetName?: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  template?: "outstation_expenses";
  /**
   * Which identity the sheet wears. Defaults to "phoenix" so every existing caller is untouched.
   *
   * A THEME PARAMETER RATHER THAN A SECOND FUNCTION, because this one is performance-tuned: its
   * style objects are hoisted and shared by reference across every cell, which is what stopped a
   * tens-of-thousands-row export from allocating millions of throwaway styles. A house-flavoured
   * copy would have had to reproduce that care exactly, and would drift from it the first time
   * either side was touched.
   */
  theme?: TableTheme;
};

export type TableTheme = "phoenix" | "house";

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

/**
 * The SATO house grid: a hairline under each row and nothing else. The Phoenix kit boxes every
 * cell on four sides; the house format rules rows, not cells.
 */
function houseGridBorder(): ExcelJS.Borders {
  return {
    bottom: { style: "hair" as const, color: { argb: HOUSE_XLSX_COLORS.hair } },
  } as ExcelJS.Borders;
}

/** Everything the sheet needs to wear one identity or the other, resolved once per sheet. */
function resolveTheme(theme: TableTheme) {
  if (theme === "house") {
    return {
      band: null,
      bodyColour: HOUSE_XLSX_COLORS.body,
      font: "Aptos",
      grid: houseGridBorder(),
      headerBorder: {
        bottom: { style: "medium" as const, color: { argb: HOUSE_XLSX_COLORS.blue } },
        top: { style: "thin" as const, color: { argb: HOUSE_XLSX_COLORS.hair } },
      } as ExcelJS.Borders,
      headerColour: HOUSE_XLSX_COLORS.deep,
      subtitleColour: HOUSE_XLSX_COLORS.muted,
      titleColour: HOUSE_XLSX_COLORS.deep,
      titleRule: { bottom: { style: "medium" as const, color: { argb: HOUSE_XLSX_COLORS.blue } } } as ExcelJS.Borders,
      totalColour: HOUSE_XLSX_COLORS.deep,
      totalFill: null,
      zebra: HOUSE_XLSX_COLORS.tint,
    };
  }
  return {
    band: BLACK,
    bodyColour: SLATE,
    font: "Calibri",
    grid: gridBorder(),
    headerBorder: gridBorder(),
    headerColour: WHITE,
    subtitleColour: WHITE,
    titleColour: WHITE,
    titleRule: { bottom: { style: "medium" as const, color: { argb: ORANGE } } } as ExcelJS.Borders,
    totalColour: BLACK,
    totalFill: ORANGE_SOFT,
    zebra: ORANGE_SOFT,
  };
}

function sanitizeSheetName(name: string | undefined) {
  const cleaned = (name ?? "Export").replace(/[\\/?*[\]:]/g, " ").trim();
  return (cleaned || "Export").slice(0, 31);
}

export async function buildPhoenixTableWorkbook(input: BuildTableWorkbookInput) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Phoenix Workforce";
  workbook.created = new Date();

  if (input.template === "outstation_expenses") {
    return buildOutstationExpenseWorkbook(workbook, input);
  }

  addPhoenixTableSheet(workbook, input);
  return await workbook.xlsx.writeBuffer();
}

/**
 * Render one premium Phoenix-styled table sheet (title band + subtitle + header + zebra rows +
 * SUM total) into an existing workbook. Reused by multi-sheet builders (e.g. Source of Sales).
 */
export function addPhoenixTableSheet(workbook: ExcelJS.Workbook, input: BuildTableWorkbookInput) {
  const sheet = workbook.addWorksheet(sanitizeSheetName(input.sheetName ?? input.title), {
    views: [{ state: "frozen", ySplit: 3 }],
  });

  const colCount = Math.max(1, input.columns.length);
  const theme = resolveTheme(input.theme ?? "phoenix");

  // Row 1 — the title. A filled band in the Phoenix theme; type over a Brand Blue rule in the house
  // one, where nothing but the zebra is ever filled.
  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = input.title;
  titleCell.font = { name: theme.font, size: 16, bold: true, color: { argb: theme.titleColour } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  if (theme.band) titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.band } };
  titleCell.border = theme.titleRule;
  sheet.getRow(1).height = theme.band ? 36 : 30;

  // Row 2 — subtitle
  sheet.mergeCells(2, 1, 2, colCount);
  const subCell = sheet.getCell(2, 1);
  subCell.value = input.subtitle ?? `Phoenix Workforce · exported ${new Date().toLocaleString("en-GB")}`;
  subCell.font = { name: theme.font, size: 10, italic: theme.band !== null, color: { argb: theme.subtitleColour } };
  subCell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
  if (theme.band) subCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.band } };
  sheet.getRow(2).height = 18;

  // Row 3 — header
  const headerRow = sheet.getRow(3);
  input.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label;
    cell.font = { name: theme.font, size: 11.5, bold: true, color: { argb: theme.headerColour } };
    cell.alignment = {
      vertical: theme.band ? "middle" : "bottom",
      horizontal: theme.band ? "center" : col.numeric ? "right" : "left",
      wrapText: true,
    };
    if (theme.band) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.band } };
    cell.border = theme.headerBorder;
  });
  headerRow.height = theme.band ? 22 : 26;

  // Data rows. Style objects are hoisted and SHARED by reference across every cell instead of
  // allocated per cell — for a large export (e.g. the CRM Visits tab, tens of thousands of rows ×
  // ~25 columns) the old per-cell allocation created millions of throwaway style objects, which was
  // the dominant memory/time cost behind the export hanging. ExcelJS reads these at write time, so
  // sharing one frozen instance is safe and identical in output.
  const firstDataRow = 4;
  const dataFont = { name: theme.font, size: 10.5, color: { argb: theme.bodyColour } } as const;
  const dataBorder = theme.grid;
  const alignLeft = { vertical: "middle", horizontal: "left", wrapText: false } as const;
  const alignRight = { vertical: "middle", horizontal: "right", wrapText: false } as const;
  const zebraFill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.zebra } } as const;
  const colAlign = input.columns.map((col) => (col.numeric ? alignRight : alignLeft));
  // Precomputed alongside colAlign for the same reason: one lookup per cell, no per-cell
  // allocation. A shared string literal costs nothing to reuse.
  const colTextFormat = input.columns.map((col) => (col.text ? "@" : null));
  input.rows.forEach((row, r) => {
    const excelRow = sheet.getRow(firstDataRow + r);
    const zebra = r % 2 === 1;
    input.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      const raw = row[col.key];
      cell.value = raw === null || raw === undefined ? "" : raw;
      cell.font = dataFont;
      cell.alignment = colAlign[i];
      cell.border = dataBorder;
      const textFormat = colTextFormat[i];
      if (textFormat) cell.numFmt = textFormat;
      if (zebra) cell.fill = zebraFill;
    });
  });

  // TOTAL row with SUM() formulas for numeric columns (formulas if available)
  const numericColumns = input.columns.filter((col) => col.numeric);
  if (numericColumns.length > 0 && input.rows.length > 0) {
    const totalRowIndex = firstDataRow + input.rows.length;
    const totalRow = sheet.getRow(totalRowIndex);
    input.columns.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1);
      cell.font = { name: theme.font, size: 10.5, bold: true, color: { argb: theme.totalColour } };
      if (theme.totalFill) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: theme.totalFill } };
      }
      cell.border = theme.totalFill
        ? theme.grid
        : ({
            bottom: { style: "double" as const, color: { argb: HOUSE_XLSX_COLORS.blue } },
            top: { style: "thin" as const, color: { argb: HOUSE_XLSX_COLORS.blue } },
          } as ExcelJS.Borders);
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

  // Column widths — estimated from a bounded sample of rows (not all of them). On a tens-of-thousands
  // -row export the full O(rows × cols) scan was itself a measurable cost; the first N rows give an
  // effectively identical width for a display grid.
  const WIDTH_SAMPLE = 1000;
  const widthRows = input.rows.length > WIDTH_SAMPLE ? input.rows.slice(0, WIDTH_SAMPLE) : input.rows;
  input.columns.forEach((col, i) => {
    const longest = widthRows.reduce((max, row) => {
      const value = row[col.key];
      return Math.max(max, value === null || value === undefined ? 0 : String(value).length);
    }, col.label.length);
    sheet.getColumn(i + 1).width = col.width ?? Math.max(12, Math.min(46, longest + 4));
  });
}

function numberCell(row: ExportRow, key: string) {
  const value = row[key];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumRows(rows: ExportRow[], key: string) {
  return rows.reduce((total, row) => total + numberCell(row, key), 0);
}

function moneyFormat(cell: ExcelJS.Cell) {
  cell.numFmt = '#,##0.00';
}

// Distance / count columns are whole numbers, not currency.
function countFormat(cell: ExcelJS.Cell) {
  cell.numFmt = '#,##0';
}

function applyNumericFormat(cell: ExcelJS.Cell, key: string) {
  if (key === "km") countFormat(cell);
  else moneyFormat(cell);
}


function styleBand(cell: ExcelJS.Cell, fill: string, fontColor = WHITE) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
  cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: fontColor } };
  cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  cell.border = gridBorder();
}

async function buildOutstationExpenseWorkbook(
  workbook: ExcelJS.Workbook,
  input: BuildTableWorkbookInput,
) {
  const generatedAt = new Date().toLocaleString("en-GB");
  const total = sumRows(input.rows, "total");
  const travel = sumRows(input.rows, "travelCost");
  const meeting = sumRows(input.rows, "meetingAmount");
  const allowance = sumRows(input.rows, "allowance");
  const other = sumRows(input.rows, "other");
  const km = sumRows(input.rows, "km");
  const approvedRows = input.rows.filter((row) =>
    String(row.status ?? "").toLowerCase().includes("approved"),
  ).length;

  const dashboard = workbook.addWorksheet("Dashboard", {
    views: [{ showGridLines: false }],
  });
  dashboard.columns = Array.from({ length: 10 }, () => ({ width: 16 }));
  dashboard.mergeCells("A1:J2");
  const title = dashboard.getCell("A1");
  title.value = "PHOENIX WORKFORCE - OUTSTATION EXPENSE DASHBOARD";
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  title.font = { name: "Calibri", size: 18, bold: true, color: { argb: ORANGE } };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  dashboard.mergeCells("A3:J3");
  const subtitle = dashboard.getCell("A3");
  subtitle.value = input.subtitle ?? `Generated ${generatedAt}`;
  subtitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  subtitle.font = { name: "Calibri", size: 10, italic: true, color: { argb: MUTED } };
  subtitle.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  const kpis = [
    ["Rows", input.rows.length],
    ["Approved", approvedRows],
    ["Total", total],
    ["Travel Cost", travel],
    ["Meeting Amount", meeting],
    ["Allowance", allowance],
    ["Other", other],
    ["KM", km],
  ];
  let rowIndex = 5;
  for (let index = 0; index < kpis.length; index += 1) {
    const col = index % 4;
    if (index > 0 && col === 0) rowIndex += 4;
    const startCol = col * 2 + 1;
    dashboard.mergeCells(rowIndex, startCol, rowIndex, startCol + 1);
    dashboard.mergeCells(rowIndex + 1, startCol, rowIndex + 2, startCol + 1);
    const labelCell = dashboard.getCell(rowIndex, startCol);
    const valueCell = dashboard.getCell(rowIndex + 1, startCol);
    labelCell.value = kpis[index][0];
    valueCell.value = kpis[index][1] as number;
    labelCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE } };
    labelCell.font = { name: "Calibri", size: 10, bold: true, color: { argb: WHITE } };
    labelCell.alignment = { horizontal: "center", vertical: "middle" };
    valueCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
    valueCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: BLACK } };
    valueCell.alignment = { horizontal: "center", vertical: "middle" };
    valueCell.border = gridBorder();
    labelCell.border = gridBorder();
    if (["Total", "Travel Cost", "Meeting Amount", "Allowance", "Other"].includes(String(kpis[index][0]))) {
      moneyFormat(valueCell);
    }
  }

  dashboard.mergeCells("A14:J14");
  const dashboardNote = dashboard.getCell("A14");
  dashboardNote.value =
    "Total is the authoritative per-row amount. Component columns (Travel Cost, Meeting Amount, Allowance, Other) are provided for breakdown and may not re-sum to Total for historically imported rows. The detailed sheet preserves the source report headers exactly.";
  dashboardNote.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEDD5" } };
  dashboardNote.font = { name: "Calibri", size: 11, bold: true, color: { argb: SLATE } };
  dashboardNote.alignment = { vertical: "middle", horizontal: "left", wrapText: true };
  dashboard.getRow(14).height = 34;

  const policy = workbook.addWorksheet("Premium Policy", {
    views: [{ showGridLines: false }],
  });
  policy.columns = [
    { width: 28 },
    { width: 82 },
  ];
  policy.mergeCells("A1:B2");
  const policyTitle = policy.getCell("A1");
  policyTitle.value = "PHOENIX EXPENSE POLICY NOTES";
  policyTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  policyTitle.font = { name: "Calibri", size: 16, bold: true, color: { argb: ORANGE } };
  policyTitle.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  const policyRows = [
    ["Identity", "Phoenix Workforce branded export for outstation expense governance."],
    ["Confidentiality", "This workbook may contain employee route, workload, and payroll-sensitive information."],
    ["Required headers", input.columns.map((column) => column.label).join(", ")],
    ["Total rule", "Total is the authoritative per-row amount; component columns are for breakdown and may not re-sum to Total for historically imported rows."],
    ["Review rule", "HR and HR Notes are preserved for payroll review and audit context."],
    ["Generated", generatedAt],
  ];
  policyRows.forEach((item, index) => {
    const row = policy.getRow(index + 4);
    row.getCell(1).value = item[0];
    row.getCell(2).value = item[1];
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
    row.getCell(1).font = { name: "Calibri", size: 11, bold: true, color: { argb: BLACK } };
    row.getCell(2).font = { name: "Calibri", size: 11, color: { argb: SLATE } };
    row.getCell(1).border = gridBorder();
    row.getCell(2).border = gridBorder();
    row.getCell(2).alignment = { vertical: "middle", wrapText: true };
    row.height = 28;
  });

  const sheet = workbook.addWorksheet(sanitizeSheetName(input.sheetName ?? "Outstation Expenses"), {
    views: [{ state: "frozen", ySplit: 4 }],
  });
  const colCount = Math.max(1, input.columns.length);
  sheet.mergeCells(1, 1, 1, colCount);
  const dataTitle = sheet.getCell(1, 1);
  dataTitle.value = "PHOENIX WORKFORCE - OUTSTATION EXPENSE REPORT";
  dataTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  dataTitle.font = { name: "Calibri", size: 16, bold: true, color: { argb: ORANGE } };
  dataTitle.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, colCount);
  const dataSubtitle = sheet.getCell(2, 1);
  dataSubtitle.value = input.subtitle ?? `Phoenix Workforce - generated ${generatedAt}`;
  dataSubtitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  dataSubtitle.font = { name: "Calibri", size: 10, italic: true, color: { argb: MUTED } };
  dataSubtitle.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  sheet.mergeCells(3, 1, 3, colCount);
  const identity = sheet.getCell(3, 1);
  identity.value = "Premium policy workbook - Dashboard, policy notes, and source table.";
  identity.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
  identity.font = { name: "Calibri", size: 10, bold: true, color: { argb: SLATE } };
  identity.alignment = { vertical: "middle", horizontal: "left", indent: 1 };

  const headerRow = sheet.getRow(4);
  input.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.label;
    styleBand(cell, BLACK);
  });
  headerRow.height = 28;

  const firstDataRow = 5;
  input.rows.forEach((row, r) => {
    const excelRow = sheet.getRow(firstDataRow + r);
    input.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      const raw = row[col.key];
      cell.value = raw === null || raw === undefined ? "" : raw;
      cell.font = { name: "Calibri", size: 10.5, color: { argb: SLATE } };
      cell.alignment = {
        vertical: "middle",
        horizontal: col.numeric ? "right" : "left",
        wrapText: ["address", "description", "hrNotes"].includes(col.key),
      };
      cell.border = gridBorder();
      if (r % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ORANGE_SOFT } };
      }
      if (col.numeric) applyNumericFormat(cell, col.key);
    });
  });

  if (input.rows.length > 0) {
    const totalRowIndex = firstDataRow + input.rows.length;
    const totalRow = sheet.getRow(totalRowIndex);
    input.columns.forEach((col, i) => {
      const cell = totalRow.getCell(i + 1);
      cell.font = { name: "Calibri", size: 10.5, bold: true, color: { argb: BLACK } };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEDD5" } };
      cell.border = gridBorder();
      if (i === 0) {
        cell.value = "TOTAL";
      } else if (col.numeric) {
        const letter = sheet.getColumn(i + 1).letter;
        cell.value = { formula: `SUM(${letter}${firstDataRow}:${letter}${firstDataRow + input.rows.length - 1})` };
        cell.alignment = { vertical: "middle", horizontal: "right" };
        applyNumericFormat(cell, col.key);
      }
    });
  }

  input.columns.forEach((col, i) => {
    const longest = input.rows.reduce((max, row) => {
      const value = row[col.key];
      return Math.max(max, value === null || value === undefined ? 0 : String(value).length);
    }, col.label.length);
    sheet.getColumn(i + 1).width = col.width ?? Math.max(12, Math.min(50, longest + 4));
  });

  return await workbook.xlsx.writeBuffer();
}
