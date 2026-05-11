import { NextResponse } from "next/server";
import * as XLSX from "xlsx";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type { RawEmployeeImportRow } from "@/lib/imports/employee-import-types";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function parseExcelRows(file: File) {
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), {
      cellDates: true,
      type: "array",
    });
    const firstSheetName = workbook.SheetNames[0];

    if (!firstSheetName) {
      return { error: "empty_worksheet" as const };
    }

    const firstSheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json<RawEmployeeImportRow>(firstSheet, {
      defval: null,
    });

    if (rows.length === 0) {
      return { error: "empty_worksheet" as const };
    }

    return { rows };
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

    return NextResponse.json(createEmployeeImportPlan(parsed.rows));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to import employees." }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Employee import dry run failed.";
    return NextResponse.json({ error: "employee_import_dry_run_failed", message }, { status: 500 });
  }
}
