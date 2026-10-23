import { NextResponse } from "next/server";

import { isSalaryBlindRole } from "@/lib/auth/hr-functions";
import { assertPermission, canAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  buildEmployeeImportFixListWorkbook,
  employeeImportFixListFileName,
} from "@/lib/employees/employee-import-fix-list-workbook";
import { loadEmployeeImportExistingState } from "@/lib/imports/employee-import-existing-state";
import { createEmployeeImportPlan } from "@/lib/imports/employee-import-plan";
import { salaryBlindImportRefusal } from "@/lib/imports/employee-import-salary-blind";
import type { RawEmployeeImportRow } from "@/lib/imports/employee-import-types";
import { parseEmployeeUploadRows } from "@/lib/imports/employee-upload-parse";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The dry run's findings, as a workbook.
 *
 * WRITES NOTHING. It runs exactly what `dry-run` runs — same permission, same parser, same plan —
 * and renders the result instead of returning JSON. Keeping it a separate route rather than a flag
 * on `dry-run` keeps that response a plain JSON contract for the UI, and means downloading the
 * findings cannot accidentally become the thing that imports them.
 *
 * The file is re-parsed rather than the preview being posted back, because the preview is the
 * user's copy of a judgement and this has to be the server's. Re-running it costs one parse and
 * removes any chance of rendering findings that no longer match the file.
 */
export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // The same gate as the dry run: this reads employee data and describes pending changes to it.
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
      tooLargeMessage: spreadsheetTooLargeMessage("Employee import file"),
      unsupportedError: "unsupported_format",
      unsupportedMessage: "Upload an employee import Excel file in .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { error: fileValidation.error, message: fileValidation.message },
        { status: fileValidation.status },
      );
    }

    const parsed = await parseEmployeeUploadRows<RawEmployeeImportRow>(file);

    if ("error" in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    // Exactly what the dry run decides, so the two can never disagree (dry-run/route.ts).
    const salaryBlind = isSalaryBlindRole(access.role);
    if (salaryBlind) {
      const refusal = salaryBlindImportRefusal(parsed.rows);
      if (refusal) return NextResponse.json(refusal, { status: 400 });
    }
    const allowNewEmployees = await canAccess(access, "employees", "create");

    const existingState = await loadEmployeeImportExistingState();
    const result = createEmployeeImportPlan(parsed.rows, {
      allowNewEmployees,
      existingState,
      firstDataRowNumber: parsed.firstDataRowNumber,
      salaryBlind,
    });

    const workbook = await buildEmployeeImportFixListWorkbook({
      omitMoney: salaryBlind,
      result,
      sourceFileName: file.name,
    });
    const buffer = await workbook.xlsx.writeBuffer();

    return new Response(buffer, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="${employeeImportFixListFileName()}"`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: "You do not have access to import employees." },
        { status: 403 },
      );
    }

    return NextResponse.json(
      {
        error: "employee_import_fix_list_failed",
        message: clientSafeErrorMessage(error, "Unable to build the list of things to fix."),
      },
      { status: 500 },
    );
  }
}
