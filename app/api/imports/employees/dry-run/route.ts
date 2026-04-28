import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type {
  EmployeeImportValidationResult,
  RawEmployeeImportRow,
} from "@/lib/imports/employee-import-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_EXTENSIONS = new Set([".xls", ".xlsx"]);
const SUPPORTED_MIME_TYPES = new Set([
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

function getFileExtension(fileName: string) {
  const dotIndex = fileName.lastIndexOf(".");

  if (dotIndex === -1) {
    return "";
  }

  return fileName.slice(dotIndex).toLowerCase();
}

function isSupportedExcelFile(file: File) {
  const extension = getFileExtension(file.name);
  const mimeType = file.type.toLowerCase();

  return (
    SUPPORTED_EXTENSIONS.has(extension) ||
    (mimeType.length > 0 && SUPPORTED_MIME_TYPES.has(mimeType))
  );
}

function toDryRunResponse(result: EmployeeImportValidationResult) {
  return {
    totalRows: result.totalRows,
    validRows: result.validRows,
    warningRows: result.warningRows,
    failedRows: result.failedRows,
    detectedColumns: result.detectedColumns,
    missingRequiredColumns: result.missingRequiredColumns,
    duplicateHrIds: result.duplicateHrIds,
    organizationEntitiesToCreate: result.organizationEntitiesToCreate,
    rowsToInsert: result.rowsToInsert,
    rowsToUpdate: result.rowsToUpdate,
    validationErrors: result.validationErrors,
    validationWarnings: result.validationWarnings,
  };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }

    if (!isSupportedExcelFile(file)) {
      return NextResponse.json(
        { error: "unsupported_format" },
        { status: 400 },
      );
    }

    if (file.size === 0) {
      return NextResponse.json(
        { error: "invalid_excel_file" },
        { status: 400 },
      );
    }

    let workbook: XLSX.WorkBook;

    try {
      workbook = XLSX.read(await file.arrayBuffer(), {
        cellDates: true,
        type: "array",
      });
    } catch {
      return NextResponse.json(
        { error: "invalid_excel_file" },
        { status: 400 },
      );
    }

    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      return NextResponse.json(
        { error: "empty_worksheet" },
        { status: 400 },
      );
    }

    const firstSheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json<RawEmployeeImportRow>(firstSheet, {
      defval: null,
    });

    if (rows.length === 0) {
      return NextResponse.json(
        { error: "empty_worksheet" },
        { status: 400 },
      );
    }

    const dryRunResult = createEmployeeImportPlan(rows);

    return NextResponse.json(toDryRunResponse(dryRunResult));
  } catch {
    return NextResponse.json(
      { error: "employee_import_dry_run_failed" },
      { status: 500 },
    );
  }
}
