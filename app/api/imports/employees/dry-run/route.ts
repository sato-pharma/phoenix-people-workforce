import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadEmployeeImportExistingState } from "@/lib/imports/employee-import-existing-state";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type { RawEmployeeImportRow } from "@/lib/imports/employee-import-types";
import {
  excelCellText,
  excelWorksheetToJsonRows,
  firstExcelWorksheet,
  loadExcelWorkbook,
} from "@/lib/uploads/exceljs-rows";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parseExcelRows(file: File) {
  try {
    const workbook = await loadExcelWorkbook(await file.arrayBuffer());
    const firstSheet = firstExcelWorksheet(workbook);

    if (!firstSheet) {
      return { error: "empty_worksheet" as const };
    }

    let headerRowNumber = 1;
    for (let rowNumber = 1; rowNumber <= Math.min(firstSheet.rowCount, 10); rowNumber += 1) {
      const row = firstSheet.getRow(rowNumber);
      const values = Array.from({ length: firstSheet.columnCount }, (_, index) =>
        excelCellText(row.getCell(index + 1).value).toLowerCase(),
      );

      if (
        values.some((value) => ["employee id", "hr_id", "hr id", "employee code"].includes(value)) &&
        values.some((value) => value === "full name")
      ) {
        headerRowNumber = rowNumber;
        break;
      }
    }

    const rows = excelWorksheetToJsonRows(firstSheet, headerRowNumber, {
      defaultValue: null,
    }) as RawEmployeeImportRow[];

    if (rows.length === 0) {
      return { error: "empty_worksheet" as const };
    }

    return { firstDataRowNumber: headerRowNumber + 1, rows };
  } catch {
    return { error: "invalid_excel_file" as const };
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "imports", "import");

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file" }, { status: 400 });
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_excel_file",
      emptyMessage: "Employee import file is empty.",
      tooLargeError: "employee_import_file_too_large",
      tooLargeMessage: "Employee import file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload an employee import Excel file in .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json({ error: fileValidation.error, message: fileValidation.message }, { status: fileValidation.status });
    }

    const parsed = await parseExcelRows(file);

    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const existingState = await loadEmployeeImportExistingState();

    return NextResponse.json(createEmployeeImportPlan(parsed.rows, {
      existingState,
      firstDataRowNumber: parsed.firstDataRowNumber,
    }));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to import employees." }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Employee import dry run failed.";
    return NextResponse.json({ error: "employee_import_dry_run_failed", message }, { status: 500 });
  }
}
