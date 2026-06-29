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
  template?: "outstation_expenses";
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

  // Row 1 — title band (black, white title, orange bottom-border accent)
  sheet.mergeCells(1, 1, 1, colCount);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = input.title;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: WHITE } };
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLACK } };
  titleCell.border = { bottom: { style: "medium", color: { argb: ORANGE } } };
  sheet.getRow(1).height = 36;

  // Row 2 — subtitle band
  sheet.mergeCells(2, 1, 2, colCount);
  const subCell = sheet.getCell(2, 1);
  subCell.value = input.subtitle ?? `Phoenix Workforce · exported ${new Date().toLocaleString("en-GB")}`;
  subCell.font = { name: "Calibri", size: 10, italic: true, color: { argb: WHITE } };
  subCell.alignment = { vertical: "middle", horizontal: "left", indent: 1, wrapText: true };
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
