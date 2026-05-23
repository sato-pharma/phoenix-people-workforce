import { NextResponse } from "next/server";
import ExcelJS from "exceljs";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadEmployeeImportExistingState } from "@/lib/imports/employee-import-existing-state";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type { RawEmployeeImportRow } from "@/lib/imports/employee-import-types";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parseExcelRows(file: File) {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await file.arrayBuffer());

    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      return { error: "empty_worksheet" as const };
    }

    let headerRowNum = 1;
    const maxRows = Math.min(worksheet.rowCount || 0, 11);

    for (let rowNum = 1; rowNum <= maxRows; rowNum += 1) {
      const row = worksheet.getRow(rowNum);
      const values: string[] = [];

      row.eachCell((cell) => {
        values.push(String(cell.value ?? "").trim().toLowerCase());
      });

      if (
        values.some((value) => ["employee id", "hr_id", "hr id", "employee code"].includes(value)) &&
        values.some((value) => value === "full name")
      ) {
        headerRowNum = rowNum;
        break;
      }
    }

    const rows: RawEmployeeImportRow[] = [];
    const headerRow = worksheet.getRow(headerRowNum);
    const headers: Map<number, string> = new Map();

    headerRow.eachCell((cell, colNum) => {
      headers.set(colNum, String(cell.value ?? "").trim());
    });

    worksheet.eachRow((row, rowNum) => {
      if (rowNum <= headerRowNum) return;

      const record: Record<string, unknown> = {};
      row.eachCell((cell, colNum) => {
        const key = headers.get(colNum);
        if (key) {
          record[key] = cell.value ?? null;
        }
      });

      if (Object.values(record).some((v) => v)) {
        rows.push(record as RawEmployeeImportRow);
      }
    });

    if (rows.length === 0) {
      return { error: "empty_worksheet" as const };
    }

    return { firstDataRowNumber: headerRowNum + 1, rows };
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
      ...excelSpreadsheetValidation,
      emptyError: "invalid_excel_file",
      emptyMessage: "Employee import file is empty.",
      tooLargeError: "employee_import_file_too_large",
      tooLargeMessage: "Employee import file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload an employee import Excel file in .xls or .xlsx format.",
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
