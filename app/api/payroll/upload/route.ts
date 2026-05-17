import { NextResponse } from "next/server";

import { safeSendNotificationEmail } from "@/lib/notifications/email";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import {
  createSalaryBatch,
  findSalaryBatchForPeriod,
  isPayrollSchemaMissing,
  payrollPeriodConflictForBatch,
} from "@/lib/payroll/service";
import { upsertPayrollResignationCandidates } from "@/lib/resignations/service";
import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function payrollPeriodConflictResponse(conflict: ReturnType<typeof payrollPeriodConflictForBatch>) {
  return NextResponse.json(
    {
      conflict,
      error: conflict.replaceable ? "payroll_period_conflict" : "payroll_period_closed",
      message: conflict.message,
    },
    { status: 409 },
  );
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payroll", "import");
    const formData = await request.formData();
    const file = formData.get("file");
    const rawMonth = formData.get("month");
    const rawYear = formData.get("year");
    const month = Number(rawMonth);
    const year = Number(rawYear);

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "missing_file", message: "Salary file is required." }, { status: 400 });
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

    if (!rawMonth || !rawYear) {
      return NextResponse.json(
        { error: "missing_payroll_period", message: "Payroll month and year are required." },
        { status: 400 },
      );
    }

    try {
      assertValidPayrollPeriod(month, year);
    } catch (error) {
      return NextResponse.json(
        {
          error: "invalid_payroll_period",
          message: error instanceof Error ? error.message : "Payroll period is invalid.",
        },
        { status: 400 },
      );
    }

    const existingBatch = await findSalaryBatchForPeriod(month, year);
    if (existingBatch) {
      return payrollPeriodConflictResponse(payrollPeriodConflictForBatch(existingBatch));
    }

    const salarySources = await getPayrollSalarySourcesByHrId({ month, year });
    const validation = await validateSalaryWorkbook(file, {
      expectedPeriod: { month, year },
      salarySources,
    });
    const actor = resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
    await upsertPayrollResignationCandidates({
      actor,
      candidates: validation.payrollResignationCandidates,
      month,
      sourceFileName: file.name,
      year,
    });

    if (
      validation.failedRows > 0 ||
      validation.missingRequiredColumns.length > 0 ||
      validation.duplicateHrIds.length > 0
    ) {
      return NextResponse.json(
        {
          error: "salary_validation_failed",
          message: "Fix blocking validation errors before confirming the upload.",
          validation,
        },
        { status: 400 },
      );
    }

    if (validation.rowsToImport.length === 0) {
      return NextResponse.json(
        {
          error: "empty_salary_upload",
          message: "Salary upload file must include at least one salary row.",
          validation,
        },
        { status: 400 },
      );
    }

    const payrollGovernanceWarnings = validation.validationWarnings.filter(
      (warning) => warning.code !== "employee_not_found",
    );

    const result = await createSalaryBatch({
      fileName: file.name,
      month,
      records: validation.rowsToImport,
      uploadedBy: actor,
      validationWarnings: payrollGovernanceWarnings,
      year,
    });

    await safeSendNotificationEmail({
      ctaHref: `/payroll?batchId=${result.batch.id}`,
      ctaLabel: "Open payroll dashboard",
      metrics: [
        { label: "Payroll period", value: `${month}/${year}` },
        { label: "Imported salary records", value: result.importedRecords },
        { label: "Governance warnings", value: result.governanceWarnings },
        { label: "Source file", value: file.name },
      ],
      notificationType: "general",
      subject: `Phoenix Payroll upload imported - ${month}/${year}`,
      summary: "A payroll salary upload was validated and imported successfully. Review governance warnings before approval.",
      title: "Payroll Upload Imported",
      tone: result.governanceWarnings > 0 ? "warning" : "success",
    });

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll upload failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    if (isPayrollConflictError(error)) {
      return NextResponse.json({ error: "payroll_period_conflict", message }, { status: 409 });
    }
    const schemaMissing = isPayrollSchemaMissing(error);

    return NextResponse.json(
      {
        error: schemaMissing ? "payroll_schema_not_ready" : "payroll_upload_failed",
        message,
      },
      { status: schemaMissing ? 503 : 500 },
    );
  }
}
