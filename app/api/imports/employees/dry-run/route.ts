import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { loadEmployeeImportExistingState } from "@/lib/imports/employee-import-existing-state";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import type { RawEmployeeImportRow } from "@/lib/imports/employee-import-types";
import { parseEmployeeUploadRows } from "@/lib/imports/employee-upload-parse";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // Deliberately the `employees` resource, not `imports` — this mutates employee
    // records and Super Admin/Talent Acquisition are the only roles that can reach
    // this page at all. `imports` gates the unrelated /api/admin/users/bulk instead.
    await assertPermission(access, "employees", "import");

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

    const parsed = await parseEmployeeUploadRows<RawEmployeeImportRow>(file);

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

    const message = clientSafeErrorMessage(error, "Employee import dry run failed.");
    return NextResponse.json({ error: "employee_import_dry_run_failed", message }, { status: 500 });
  }
}
