import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { getSalaryBatchById, isPayrollSchemaMissing, replaceSalaryBatch } from "@/lib/payroll/service";
import { upsertPayrollResignationCandidates } from "@/lib/resignations/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { excelSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

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
      tooLargeMessage: spreadsheetTooLargeMessage("Salary file"),
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

    const salarySources = await getPayrollSalarySourcesByHrId({
      month: existingBatch.month,
      year: existingBatch.year,
    });
    const validation = await validateSalaryWorkbook(file, {
      expectedPeriod: { month: existingBatch.month, year: existingBatch.year },
      salarySources,
    });
    const actor = hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await upsertPayrollResignationCandidates({
      actor,
      candidates: validation.payrollResignationCandidates,
      month: existingBatch.month,
      sourceFileName: file.name,
      year: existingBatch.year,
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

    if (validation.rowsToImport.length === 0) {
      return NextResponse.json(
        {
          error: "empty_salary_replacement",
          message: "Payroll replacement file must include at least one salary row.",
          validation,
        },
        { status: 400 },
      );
    }

    const payrollGovernanceWarnings = validation.validationWarnings.filter(
      (warning) => warning.code !== "employee_not_found",
    );

    const result = await replaceSalaryBatch(id, {
      fileName: file.name,
      records: validation.rowsToImport,
      uploadedBy: actor,
      validationWarnings: payrollGovernanceWarnings,
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Payroll replace failed.");
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
