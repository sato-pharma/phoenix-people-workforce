import { NextResponse } from "next/server";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { analyzeExpenseWorkbook, unrecognizedExpenseTemplateMessage } from "@/lib/outstation/expense-import";
import {
  isPayrollExpensesSchemaMissing,
  savePayrollExpenseApprovals,
} from "@/lib/outstation/expenses";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "payroll expenses administration");

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
      tooLargeMessage: spreadsheetTooLargeMessage("Expenses file"),
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
    if (!analysis.template?.recognized) {
      return NextResponse.json(
        {
          ...analysis,
          error: "unrecognized_expense_template",
          // The Expense Approvals download is refused here, by name — see expense-import.ts.
          message: unrecognizedExpenseTemplateMessage(analysis),
        },
        { status: 400 },
      );
    }
    if (analysis.validation.errors.length > 0) {
      return NextResponse.json(
        {
          ...analysis,
          error: "expense_validation_failed",
          message: analysis.validation.errors.join(" "),
        },
        { status: 400 },
      );
    }

    // A spreadsheet upload re-imports trip data; it is never an HR decision. Keep whatever HR
    // already decided on any trip already in Phoenix, so re-uploading a sheet (the review screen's
    // own download included) can never reset an approval, amount, approver or reason. See
    // savePayrollExpenseApprovals' `preserveStoredDecisions`.
    const expenses = await savePayrollExpenseApprovals({
      fileName: analysis.fileName,
      records: analysis.records,
    }, access, { preserveStoredDecisions: true });

    return NextResponse.json({
      ...analysis,
      records: expenses,
      saved: expenses.length,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Expenses analysis failed.");
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
