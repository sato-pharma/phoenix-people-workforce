import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { getSalaryBatchById, isPayrollSchemaMissing, replaceSalaryBatch } from "@/lib/payroll/service";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payroll", "import");
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "missing_file", message: "Salary file is required." },
        { status: 400 },
      );
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...excelSpreadsheetValidation,
      emptyError: "invalid_salary_file",
      emptyMessage: "Salary file is empty.",
      tooLargeError: "salary_file_too_large",
      tooLargeMessage: "Salary file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_salary_file_type",
      unsupportedMessage: "Upload an Excel salary file in .xls or .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { error: fileValidation.error, message: fileValidation.message },
        { status: fileValidation.status },
      );
    }

    const existingBatch = await getSalaryBatchById(id);
    if (!existingBatch) {
      return NextResponse.json(
        { error: "not_found", message: "Payroll upload not found." },
        { status: 404 },
      );
    }

    const salarySources = await getPayrollSalarySourcesByHrId();
    const validation = await validateSalaryWorkbook(file, {
      expectedPeriod: { month: existingBatch.month, year: existingBatch.year },
      salarySources,
    });

    if (
      validation.failedRows > 0 ||
      validation.missingRequiredColumns.length > 0 ||
      validation.duplicateHrIds.length > 0
    ) {
      return NextResponse.json(
        {
          error: "salary_validation_failed",
          message: "Fix blocking validation errors before replacing the upload.",
          validation,
        },
        { status: 400 },
      );
    }

    const result = await replaceSalaryBatch(id, {
      fileName: file.name,
      records: validation.rowsToImport,
      uploadedBy: resolveEmployeeIdentityId(access) ?? access.loginId ?? "system",
      validationWarnings: validation.validationWarnings,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll replace failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    if (isPayrollConflictError(error)) {
      return NextResponse.json({ error: "payroll_replace_conflict", message }, { status: 409 });
    }
    const schemaMissing = isPayrollSchemaMissing(error);

    return NextResponse.json(
      {
        error: schemaMissing ? "payroll_schema_not_ready" : "payroll_replace_failed",
        message,
      },
      { status: schemaMissing ? 503 : 500 },
    );
  }
}
