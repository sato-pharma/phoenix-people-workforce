import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { analyzeExpenseWorkbook } from "@/lib/payroll/expense-import";
import {
  isPayrollExpensesSchemaMissing,
  savePayrollExpenseApprovals,
} from "@/lib/payroll/expenses";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "expenses", "approve");

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "missing_file", message: "Expenses file is required." },
        { status: 400 },
      );
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_expenses_file",
      emptyMessage: "Expenses file is empty.",
      tooLargeError: "expenses_file_too_large",
      tooLargeMessage: "Expenses file exceeds the 10MB upload limit.",
      unsupportedError: "unsupported_expenses_file_type",
      unsupportedMessage: "Upload an Excel expenses file in .xlsx format.",
    });
    if (!fileValidation.ok) {
      return NextResponse.json(
        { error: fileValidation.error, message: fileValidation.message },
        { status: fileValidation.status },
      );
    }

    const analysis = await analyzeExpenseWorkbook(file);
    const expenses = await savePayrollExpenseApprovals({
      fileName: analysis.fileName,
      records: analysis.records,
    }, access);

    return NextResponse.json({
      ...analysis,
      records: expenses,
      saved: expenses.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Expenses analysis failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json(
      {
        error: isPayrollExpensesSchemaMissing(error)
          ? "payroll_expenses_schema_not_ready"
          : "expenses_analysis_failed",
        message,
      },
      { status: isPayrollExpensesSchemaMissing(error) ? 503 : 500 },
    );
  }
}
