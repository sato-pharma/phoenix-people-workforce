import type ExcelJS from "exceljs";
import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { bulkImportCrmCustomerBrickMappings, type CrmCustomerBulkImportInputRow } from "@/lib/crm/customer-brick";
import { excelCellText, loadExcelWorkbook } from "@/lib/uploads/exceljs-rows";
import { canUseAdminCrmWorkspace } from "@/lib/crm/admin-access";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Bulk upload counterpart to /api/admin/crm/customer-mapping/template: download the template (or use
// an already-built mapping spreadsheet with the same headers), fill in/correct Brick IDs, re-upload.
// Header lookup is name-based (case/whitespace-insensitive), not fixed-column — mirrors
// region-mapping/import/route.ts exactly, one level finer (contact instead of region).

const HEADER_ALIASES: Record<string, string[]> = {
  brickId: ["brick id", "brickid"],
  crmContactId: ["crm contactid", "contactid", "crm contact id"],
  crmContactName: ["crm contact name", "contact name"],
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
      return NextResponse.json({ error: "missing_file", message: "A customer mapping file is required.", success: false }, { status: 400 });
    }

    const validation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_customer_mapping_file",
      emptyMessage: "The customer mapping file is empty.",
      tooLargeError: "customer_mapping_file_too_large",
      tooLargeMessage: "The customer mapping file exceeds the upload limit.",
      unsupportedError: "unsupported_customer_mapping_file_type",
      unsupportedMessage: "Upload the customer mapping in .xlsx format.",
    });
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error, message: validation.message, success: false }, { status: validation.status });
    }

    const workbook = await loadExcelWorkbook(await file.arrayBuffer());
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      return NextResponse.json(
        { error: "empty_customer_mapping_sheet", message: "No data rows found in the uploaded file.", success: false },
        { status: 400 },
      );
    }

    const headerRowNumber = 1;
    const headerRow = sheet.getRow(headerRowNumber);
    const headers = Array.from({ length: sheet.columnCount }, (_, index) => excelCellText(headerRow.getCell(index + 1).value));
    const columnByKey = locateColumns(headers);

    if (!columnByKey.has("crmContactId") || !columnByKey.has("brickId")) {
      return NextResponse.json(
        {
          error: "unmatched_customer_mapping_headers",
          message: 'No sheet matching the customer mapping template was found. Required headers: "CRM contactID" and "Brick ID".',
          success: false,
        },
        { status: 400 },
      );
    }

    const cell = (row: ExcelJS.Row, key: string): string => {
      const columnIndex = columnByKey.get(key);
      return columnIndex == null ? "" : excelCellText(row.getCell(columnIndex + 1).value);
    };

    const rows: CrmCustomerBulkImportInputRow[] = [];
    const parseErrors: Array<{ reason: string; row: number }> = [];
    for (let rowNumber = headerRowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const contactIdText = cell(row, "crmContactId");
      const brickId = cell(row, "brickId");
      const crmContactName = cell(row, "crmContactName");
      const statusText = cell(row, "status");
      if (!contactIdText && !brickId && !crmContactName && !statusText) continue; // blank row

      const crmContactId = Number(contactIdText);
      if (!contactIdText || !Number.isFinite(crmContactId)) {
        parseErrors.push({ reason: `Missing or invalid CRM contactID ("${contactIdText}").`, row: rowNumber });
        continue;
      }
      rows.push({ brickId, crmContactId, crmContactName, row: rowNumber, statusText });
    }

    const result = await bulkImportCrmCustomerBrickMappings({ resolvedByHrId: access.hrId ?? null, rows });
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
      { error: "customer_mapping_import_failed", message: clientSafeErrorMessage(error, "Customer mapping import failed."), success: false },
      { status: 500 },
    );
  }
}
