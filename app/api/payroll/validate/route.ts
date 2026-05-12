import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { validateSalaryWorkbook } from "@/lib/payroll/salary-import";
import { getPayrollSalarySourcesByHrId } from "@/lib/payroll/salary-source";
import { excelSpreadsheetValidation, validateSpreadsheetFile } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "payroll", "import");

    const formData = await request.formData();
    const file = formData.get("file");
    const month = Number(formData.get("month"));
    const year = Number(formData.get("year"));

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

    if (!month || !year) {
      return NextResponse.json(
        { error: "missing_payroll_period", message: "Payroll month and year are required." },
        { status: 400 },
      );
    }

    const salarySources = await getPayrollSalarySourcesByHrId();
    const validation = await validateSalaryWorkbook(file, {
      expectedPeriod: { month, year },
      salarySources,
    });

    return NextResponse.json({
      ...validation,
      payrollPeriod: { month, year },
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You do not have access to validate payroll uploads." }, { status: 403 });
    }

    const message = error instanceof Error ? error.message : "Salary validation failed.";
    return NextResponse.json({ error: "salary_validation_failed", message }, { status: 500 });
  }
}
