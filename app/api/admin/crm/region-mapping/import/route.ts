import type ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { bulkImportCrmRegionBrickMappings, type CrmRegionBulkImportInputRow } from "@/lib/crm/region-brick";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Bulk upload counterpart to /api/admin/crm/region-mapping/template: download the template (or use
// an already-built mapping spreadsheet with the same headers), fill in/correct Brick IDs, re-upload.
// Header lookup is name-based (case/whitespace-insensitive), not fixed-column, so the owner's own
// pre-existing "crm map.xlsx" (CRM regionID / CRM region name / Brick ID, no Visit Count or Status
// columns) uploads here unchanged.

const HEADER_ALIASES: Record<string, string[]> = {
  brickId: ["brick id", "brickid"],
  crmRegionId: ["crm regionid", "regionid", "crm region id"],
  crmRegionName: ["crm region name", "region name"],
  status: ["status"],
};

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function locateColumns(headers: string[]): Map<string, number> {
  const columnByKey = new Map<string, number>();
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(normalized) && !columnByKey.has(key)) columnByKey.set(key, index);
    }
  });
  return columnByKey;
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!canUseAdminCrmWorkspace(access)) {
      return NextResponse.json(
        { error: "forbidden", message: "This action is limited to the admin CRM workspace roles.", success: false },
        { status: 403 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file", message: "A region mapping file is required.", success: false }, { status: 400 });
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_region_mapping_file",
      emptyMessage: "The region mapping file is empty.",
      tooLargeError: "region_mapping_file_too_large",
      tooLargeMessage: "The region mapping file exceeds the upload limit.",
      unsupportedError: "unsupported_region_mapping_file_type",
      unsupportedMessage: "Upload the region mapping in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error, message: validation.message, success: false }, { status: validation.status });
    }

    const workbook = await loadExcelWorkbook(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      return NextResponse.json(
        { error: "empty_region_mapping_sheet", message: "No data rows found in the uploaded file.", success: false },
        { status: 400 },
      );
    }

    const headerRowNumber = 1;
    const headerRow = sheet.getRow(headerRowNumber);
    const headers = Array.from({ length: sheet.columnCount }, (_, index) => excelCellText(headerRow.getCell(index + 1).value));
    const columnByKey = locateColumns(headers);

    if (!columnByKey.has("crmRegionId") || !columnByKey.has("brickId")) {
      return NextResponse.json(
        {
          error: "unmatched_region_mapping_headers",
          message: 'No sheet matching the region mapping template was found. Required headers: "CRM regionID" and "Brick ID".',
          success: false,
        },
        { status: 400 },
      );
    }

    const cell = (row: ExcelJS.Row, key: string): string => {
      const columnIndex = columnByKey.get(key);
      return columnIndex == null ? "" : excelCellText(row.getCell(columnIndex + 1).value);
    };

    const rows: CrmRegionBulkImportInputRow[] = [];
    const parseErrors: Array<{ reason: string; row: number }> = [];
    for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const regionIdText = cell(row, "crmRegionId");
      const brickId = cell(row, "brickId");
      const crmRegionName = cell(row, "crmRegionName");
      const statusText = cell(row, "status");
      if (!regionIdText && !brickId && !crmRegionName && !statusText) continue; // blank row

      const crmRegionId = Number(regionIdText);
      if (!regionIdText || !Number.isFinite(crmRegionId)) {
        parseErrors.push({ reason: `Missing or invalid CRM regionID ("${regionIdText}").`, row: rowNumber });
        continue;
      }
      rows.push({ brickId, crmRegionId, crmRegionName, row: rowNumber, statusText });
    }

    const result = await bulkImportCrmRegionBrickMappings({ resolvedByHrId: access.hrId ?? null, rows });
    const blockedRows = [...parseErrors, ...result.blockedRows.map((b) => ({ reason: b.reason, row: b.row }))].sort((a, b) => a.row - b.row);

    return NextResponse.json({
      success: true,
      blockedRows,
      ignored: result.ignored,
      mapped: result.mapped,
      message: `${result.mapped} mapped, ${result.ignored} ignored, ${result.skipped} skipped, ${blockedRows.length} rejected.`,
      skipped: result.skipped,
      totalRead: result.totalRead,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "region_mapping_import_failed", message: clientSafeErrorMessage(error, "Region mapping import failed."), success: false },
      { status: 500 },
    );
  }
}
