import ExcelJS from "exceljs";

// The "office" channel exports a pivot table: product NAME + total UNITS, with no geography.
// Real columns: "Row Labels" (product name) | "BUM" (a manager name, ignored) | "Sum of المبيعات"
// (= total UNITS). The data block is followed by a blank row and unrelated junk, so parsing MUST
// stop at the first fully-blank row. Units (not value) are read; office sales value is recomputed
// downstream as allocated qty × factory price.

export type OfficePivotRow = {
  productName: string;
  units: number;
  rowNumber: number;
};

export type OfficePivotParseResult = {
  rows: OfficePivotRow[];
  sheetName: string;
};

const PRODUCT_HEADERS = ["row labels", "product", "product name", "item", "item name"];
// "Sum of المبيعات" = "Sum of Sales" (the units column on the office pivot). Accept a few variants so
// a slightly different pivot caption still resolves.
const UNITS_HEADERS = [
  "sum of المبيعات", "المبيعات", "sum of sales", "sales", "units", "qty", "quantity",
  // Excel pivot auto-prefixes "Sum of Sum of …" when the measure name already starts with "Sum of"
  "sum of sum of billing quantity", "sum of billing quantity", "billing quantity",
];

function cellText(cell: ExcelJS.Cell | undefined): string {
  const value = cell?.value as unknown;
  if (value == null) return "";
  if (typeof value === "object") {
    const obj = value as { text?: unknown; result?: unknown; richText?: { text?: string }[] };
    if (obj.richText) return obj.richText.map((part) => part.text ?? "").join("").trim();
    if (obj.result != null) return String(obj.result).trim();
    if (obj.text != null) return String(obj.text).trim();
  }
  return String(value).trim();
}

function parseUnits(value: string): number {
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return Number.NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
}

function findHeaderColumns(sheet: ExcelJS.Worksheet): { headerRow: number; productCol: number; unitsCol: number } | null {
  const maxScan = Math.min(sheet.rowCount, 10);
  for (let r = 1; r <= maxScan; r += 1) {
    const row = sheet.getRow(r);
    let productCol = 0;
    let unitsCol = 0;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const label = cellText(cell).toLowerCase();
      if (!productCol && PRODUCT_HEADERS.includes(label)) productCol = col;
      if (!unitsCol && UNITS_HEADERS.includes(label)) unitsCol = col;
    });
    if (productCol && unitsCol) return { headerRow: r, productCol, unitsCol };
  }
  return null;
}

export async function parseOfficePivotBuffer(buffer: ArrayBuffer | Buffer): Promise<OfficePivotParseResult> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { rows: [], sheetName: "" };

  const header = findHeaderColumns(sheet);
  if (!header) return { rows: [], sheetName: sheet.name };

  const rows: OfficePivotRow[] = [];
  for (let r = header.headerRow + 1; r <= sheet.rowCount; r += 1) {
    const row = sheet.getRow(r);
    // Stop at the first fully-blank row — everything below the pivot block is unrelated junk.
    let anyValue = false;
    row.eachCell({ includeEmpty: false }, () => { anyValue = true; });
    if (!anyValue) break;

    const productName = cellText(row.getCell(header.productCol));
    if (!productName) continue; // skip stray rows with no product name (e.g. a grand-total label)
    const units = parseUnits(cellText(row.getCell(header.unitsCol)));
    rows.push({ productName, units: Number.isFinite(units) ? units : 0, rowNumber: r });
  }

  return { rows, sheetName: sheet.name };
}
