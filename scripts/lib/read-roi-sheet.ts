// Shared reader: load the flattened ROI sheet (.xlsx) into RoiSheetRawRow[] by mapping
// the sheet's column headers to the model keys. Used by the dry-run preview and the
// real importer so both consume the file identically.

import ExcelJS from "exceljs";

import type { RoiSheetRawRow } from "@/lib/marketing-requests/roi-sheet-import";

// Column header (lowercased) -> RoiSheetRawRow key. Matches the sheet exactly, including
// the "Distrbutor" spelling used in the source file.
const COLUMN_KEYS: Record<string, keyof RoiSheetRawRow> = {
  view: "view",
  "request code": "requestCode",
  name: "name",
  hr_id: "hrId",
  contact: "contact",
  date: "date",
  "pay date": "payDate",
  "request type": "requestType",
  duration: "duration",
  roi: "roi",
  "estimated cost": "estimatedCost",
  "product(s)": "productName",
  product_id: "productId",
  qty: "qty",
  distrbutor: "distributor",
  distributor: "distributor",
  distrbutor_id: "distributorId",
  distributor_id: "distributorId",
  "customer name": "customerName",
  "customer code": "customerCode",
  status: "status",
  note: "note",
};

function cellValue(cell: ExcelJS.Cell): string | number | Date | null {
  const value = cell.value;
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === "object" && "result" in value) {
    return (value as { result?: string | number | Date | null }).result ?? cell.text ?? null;
  }
  if (typeof value === "object" && "text" in value) {
    return (value as { text?: string }).text ?? null;
  }
  return value as string | number;
}

export async function readRoiSheet(sheetPath: string): Promise<RoiSheetRawRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(sheetPath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`No worksheet in ${sheetPath}`);

  const headerRow = sheet.getRow(1);
  const colToKey = new Map<number, keyof RoiSheetRawRow>();
  for (let col = 1; col <= headerRow.cellCount; col += 1) {
    const header = String(headerRow.getCell(col).text ?? "").trim().toLowerCase();
    const key = COLUMN_KEYS[header];
    if (key) colToKey.set(col, key);
  }

  const rows: RoiSheetRawRow[] = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const excelRow = sheet.getRow(r);
    const raw: RoiSheetRawRow = {};
    let hasAny = false;
    for (const [col, key] of colToKey) {
      const value = cellValue(excelRow.getCell(col));
      if (value !== null && value !== "") hasAny = true;
      (raw as Record<string, unknown>)[key] = value;
    }
    if (hasAny) rows.push(raw);
  }
  return rows;
}
