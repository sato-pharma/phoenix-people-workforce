// Sales Queue's own downloadable upload template (flat-sheet schema). Scoped to this
// module only — not shared with Source of Sales or Weekly Sales, which have their own
// separate templates and pipelines. Headers match exactly what parseSalesUpload /
// extractFlatSheetRows (src/lib/sales/parser.ts) and the column aliases in
// src/lib/sales/validation.ts already recognize, so a filled copy of this file uploads
// through the existing "Upload Sheet" flow on /sales/queue with no other changes needed.
//
// The "Sales Data" sheet has ONLY a header row (row 1) followed immediately by data rows
// — no in-sheet notes/guidance row. extractFlatSheetRows() treats every row from row 2
// onward as a data row (its only skip rule is an empty or "Grand Total" row), so an extra
// guidance row would itself get parsed as a bogus sales row and fail validation. All
// column guidance instead lives on the separate "Read Me" sheet.
import ExcelJS from "exceljs";

const HEADER_STYLE: Partial<ExcelJS.Style> = {
  font: { bold: true, color: { argb: "FFFFFFFF" }, size: 10 },
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B0B0B" } },
  alignment: { vertical: "middle", wrapText: true },
  border: { bottom: { style: "thin", color: { argb: "FFF97316" } } },
};

const SAMPLE_STYLE: Partial<ExcelJS.Style> = {
  fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0FDF4" } },
  font: { color: { argb: "FF166534" }, size: 9 },
};

type ColDef = { header: string; note: string; width: number };

// Order matches the real flat-sheet layout the parser already expects
// (detectSchemaType requires exactly "HR_ID" and "D.M." headers present).
const COLUMNS: ColDef[] = [
  { header: "D.M.", note: "District Manager's current full name (display only — attribution uses Manager HR_ID below).", width: 22 },
  { header: "Sys", note: "Area / territory name. This is the fixed, permanent unit — always fill it even if HR_ID is blank (vacant area).", width: 20 },
  { header: "HR_ID", note: "Medical rep's current HR_ID (e.g. B-100). Leave the VALUE blank only if the area is genuinely vacant (no rep currently assigned).", width: 14 },
  { header: "Manager HR_ID", note: "District Manager's current HR_ID (e.g. B-23). Fill for every row so sales attribute to the correct DSM, even when HR_ID is blank.", width: 16 },
  { header: "Line Manager HR_ID", note: "National Sales Manager's current HR_ID (e.g. A-12). Optional context.", width: 18 },
  { header: "Line", note: "Product line / business line name (e.g. Pedia, Anti Infective).", width: 16 },
  { header: "Type of Sales", note: "Retail or Stores.", width: 14 },
  { header: "Family", note: "Product family (e.g. Ivyronc).", width: 16 },
  { header: "PRODUCT", note: "Product name.", width: 16 },
  { header: "Factory Price", note: "Unit factory price.", width: 14 },
  { header: "Month", note: "1-12.", width: 8 },
  { header: "Year", note: "e.g. 2026.", width: 8 },
  { header: "Sales Units", note: "Units sold.", width: 12 },
  { header: "Sales Value", note: "EGP value sold.", width: 14 },
  { header: "Target Units", note: "Target units.", width: 12 },
  { header: "Target Value", note: "EGP target value.", width: 14 },
];

const SAMPLE_ROWS: (string | number | null)[][] = [
  ["Yehia Kamal", "Qena", "B-25", "B-23", "A-12", "Pedia", "Retail", "Ivyronc", "Ivyronc", 30.375, 5, 2026, 498, 15126.75, 608.11, 18471.27],
  ["Yehia Kamal", "Heliopolis (vacant)", null, "B-23", "A-12", "Pedia", "Retail", "Ivyronc", "Ivyronc", 30.375, 5, 2026, 0, 0, 500, 15187.5],
];

export async function generateSalesQueueTemplate(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Phoenix Workforce";

  const ws = wb.addWorksheet("Sales Data", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((col, i) => ({ key: `col${i}`, width: col.width }));

  const headerRow = ws.getRow(1);
  COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    Object.assign(cell, { style: HEADER_STYLE });
  });
  headerRow.height = 20;

  SAMPLE_ROWS.forEach((values, rowIndex) => {
    const row = ws.getRow(2 + rowIndex);
    values.forEach((value, i) => {
      const cell = row.getCell(i + 1);
      cell.value = value;
      Object.assign(cell, { style: SAMPLE_STYLE });
    });
  });

  const ref = wb.addWorksheet("Read Me");
  ref.columns = [{ key: "a", width: 40 }, { key: "b", width: 90 }];
  const refTitleStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FFFFFFFF" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B0B0B" } },
  };
  const refColHeaderStyle: Partial<ExcelJS.Style> = {
    font: { bold: true, color: { argb: "FF0B0B0B" } },
    fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF7ED" } },
  };

  const introLines = [
    "Sales Queue upload template — flat sheet format",
    "",
    "Areas and regions are permanent and never change. Employees (reps and DSMs) come and",
    "go, so an area's HR_ID and Manager HR_ID can change over time — but the row for that",
    "area should always exist and always carry the CURRENT Manager HR_ID.",
    "",
    "Rule for a vacant area (no rep currently assigned): leave HR_ID blank, but still fill",
    "in Sys (territory), Manager HR_ID, and the sales/target figures. The row counts under",
    "its District Manager's total; it just will not show as a named rep row.",
    "",
    "Rule for a vacant District (no DSM currently assigned): leave Manager HR_ID blank too.",
    "The sales/target still count in the grand total; they just will not show under a",
    "named manager row.",
    "",
    "The 'Sales Data' sheet must start with the header row immediately followed by data —",
    "replace the two green sample rows with your real rows before uploading; do not leave",
    "any extra text/notes rows in between, they will be read as sales data.",
    "",
    "Column reference:",
  ];
  introLines.forEach((line, i) => {
    const row = ref.addRow([line, ""]);
    if (i === 0) {
      row.getCell(1).style = refTitleStyle;
      row.getCell(2).style = refTitleStyle;
    }
  });

  const colHeaderRow = ref.addRow(["Column", "Meaning"]);
  colHeaderRow.getCell(1).style = refColHeaderStyle;
  colHeaderRow.getCell(2).style = refColHeaderStyle;
  COLUMNS.forEach((col) => ref.addRow([col.header, col.note]));
  ref.getColumn(2).alignment = { wrapText: true };

  return wb.xlsx.writeBuffer();
}
