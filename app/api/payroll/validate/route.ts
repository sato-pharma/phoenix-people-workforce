import { hrIdForStorage } from "@/lib/hr-id";
import { NextResponse } from "next/server";

import { assertPermission, resolveEmployeeIdentityId } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { findSalaryBatchForPeriod, payrollPeriodConflictForBatch } from "@/lib/payroll/service";
import { upsertPayrollResignationCandidates } from "@/lib/resignations/service";
import { excelSpreadsheetValidation, spreadsheetTooLargeMessage, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

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
          message: clientSafeErrorMessage(error, "Payroll period is invalid."),
        },
        { status: 400 },
      );
    }

    const salarySources = await getPayrollSalarySourcesByHrId({ month, year });
    const validation = await validateSalaryWorkbook(file, {
      expectedPeriod: { month, year },
      salarySources,
    });
    await upsertPayrollResignationCandidates({
      // Only the HR-id branch is canonicalised. The fallbacks are not hr ids at all — the last
      // one is a ROLE NAME — and running the whole expression through hrIdForStorage would
      // store SUPER ADMIN as the person who filed a resignation candidate.
      actor: hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? access.role,
      candidates: validation.payrollResignationCandidates,
      month,
      sourceFileName: file.name,
      year,
    });
    const existingBatch = await findSalaryBatchForPeriod(month, year);
    const periodConflict = existingBatch ? payrollPeriodConflictForBatch(existingBatch) : null;

    return NextResponse.json({
      ...validation,
      payrollPeriod: { month, year },
      ...(periodConflict ? { periodConflict } : {}),
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to validate payroll uploads." }, { status: 403 });
    }

    const message = clientSafeErrorMessage(error, "Salary validation failed.");
    return NextResponse.json({ error: "salary_validation_failed", message }, { status: 500 });
  }
}
