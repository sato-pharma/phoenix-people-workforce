// Weekly Sales — mapping workbook importer (Upload Mapping).
//
// Reads a filled mapping workbook back in. Each known sheet maps to one (dimension, map_type):
//   Products          → product / combined
//   Regions           → region  / combined
//   Regions (Sales)   → region  / sales
//   Regions (Stock)   → region  / stock
// Per sheet it reads the Raw Value + Official Code columns and upserts via upsertMappingRows
// (add/update only, never delete; every official code validated against the SoS master).

import type ExcelJS from "exceljs";

import { writeAuditLog } from "@/lib/admin/audit";
import { SalesWorkflowError } from "@/lib/sales/contracts";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import {
  loadOfficialRefs,
  upsertMappingRows,
  type MapType,
  type MappingDimension,
} from "@/lib/sales/weekly/mapping";

export type WeeklyMappingImportResult = {
  inserted: number;
  updated: number;
  skipped: number;
  blockedRows: { sheet: string; row: number; key: string; reason: string }[];
};

// The mapping is one combined set per distributor. Region sheet variants from older
// exports ("Regions (Sales)" / "Regions (Stock)") all fold into the same combined map.
const SHEET_TARGETS: { match: string; dimension: MappingDimension; mapType: MapType }[] = [
  { match: "products", dimension: "product", mapType: "combined" },
  { match: "regions (sales)", dimension: "region", mapType: "combined" },
  { match: "regions (stock)", dimension: "region", mapType: "combined" },
  { match: "regions", dimension: "region", mapType: "combined" },
];

const HEADER_SCAN_ROWS = 8;

function norm(value: unknown) {
  return excelCellText(value as ExcelJS.CellValue).toLowerCase();
}

function targetForSheet(sheetName: string): { dimension: MappingDimension; mapType: MapType } | null {
  const key = sheetName.trim().toLowerCase();
  // Most-specific first ("regions (sales)" before "regions").
  for (const target of SHEET_TARGETS) {
    if (key === target.match) return { dimension: target.dimension, mapType: target.mapType };
  }
  return null;
}

function findHeader(sheet: ExcelJS.Worksheet): { headerRow: number; rawCol: number; codeCol: number } | null {
  const maxRow = Math.min(sheet.rowCount, HEADER_SCAN_ROWS);
  for (let rowNumber = 1; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    let rawCol = 0;
    let codeCol = 0;
    for (let col = 1; col <= sheet.columnCount; col += 1) {
      const text = norm(row.getCell(col).value);
      if (!rawCol && text.includes("raw value")) rawCol = col;
      if (!codeCol && text.includes("official code")) codeCol = col;
    }
    if (rawCol && codeCol) return { headerRow: rowNumber, rawCol, codeCol };
  }
  return null;
}

export async function importWeeklyMappingWorkbook(input: {
  actorId: string;
  distributorCode: string;
  file: File;
}): Promise<WeeklyMappingImportResult> {
  const validation = validateSpreadsheetFile(input.file, {
    ...xlsxSpreadsheetValidation,
    emptyError: "invalid_mapping_file",
    emptyMessage: "The mapping workbook is empty.",
    tooLargeError: "mapping_file_too_large",
    tooLargeMessage: "The mapping workbook exceeds the 10MB upload limit.",
    unsupportedError: "unsupported_mapping_file_type",
    unsupportedMessage: "Upload the mapping workbook in .xlsx format.",
  });
  if (!validation.ok) throw new SalesWorkflowError(validation.error, validation.message, validation.status);

  const workbook = await loadExcelWorkbook(await input.file.arrayBuffer());
  const refs = await loadOfficialRefs();

  const result: WeeklyMappingImportResult = { inserted: 0, updated: 0, skipped: 0, blockedRows: [] };
  let matchedSheets = 0;

  for (const sheet of workbook.worksheets) {
    const target = targetForSheet(sheet.name);
    if (!target) continue;
    const header = findHeader(sheet);
    if (!header) continue;
    matchedSheets += 1;

    const rows: { rawValue: string; officialCode: string }[] = [];
    for (let rowNumber = header.headerRow + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const rawValue = excelCellText(row.getCell(header.rawCol).value);
      const officialCode = excelCellText(row.getCell(header.codeCol).value);
      if (!rawValue && !officialCode) continue;
      rows.push({ rawValue, officialCode });
    }
    if (rows.length === 0) continue;

    const upserted = await upsertMappingRows({
      actorId: input.actorId,
      distributorCode: input.distributorCode,
      dimension: target.dimension,
      mapType: target.mapType,
      rows,
      refs,
    });
    result.inserted += upserted.inserted;
    result.updated += upserted.updated;
    result.skipped += upserted.skipped;
    for (const blocked of upserted.blockedRows) {
      result.blockedRows.push({ sheet: sheet.name, row: blocked.row, key: blocked.key, reason: blocked.reason });
    }
  }

  if (matchedSheets === 0) {
    throw new SalesWorkflowError(
      "unmatched_mapping_sheet",
      "No mapping sheets (Products / Regions) were found. Download the mapping template first, fill it, then upload it.",
      400,
    );
  }

  await writeAuditLog({
    actorLoginId: input.actorId,
    entityId: input.distributorCode,
    entityType: "weekly_sales_mapping",
    newValues: {
      blocked: result.blockedRows.length,
      distributor: input.distributorCode,
      inserted: result.inserted,
      skipped: result.skipped,
      source: "weekly_mapping_import",
      updated: result.updated,
    },
    summary: `Weekly Mapping import — ${input.distributorCode}: ${result.inserted} added, ${result.updated} updated, ${result.blockedRows.length} blocked.`,
  });

  return result;
}
