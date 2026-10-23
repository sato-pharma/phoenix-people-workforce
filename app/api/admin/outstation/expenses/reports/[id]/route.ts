import { NextResponse } from "next/server";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { analyzeExpenseWorkbook, unrecognizedExpenseTemplateMessage } from "@/lib/outstation/expense-import";
import {
  deletePayrollExpenseReport,
  isPayrollExpenseLockSchemaMissing,
  isPayrollExpenseReportLocked,
  isPayrollExpensesSchemaMissing,
  savePayrollExpenseApprovals,
} from "@/lib/outstation/expenses";
import { isWorkflowExpenseReportProtected } from "@/lib/outstation/workflow-expense-report-guard";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { spreadsheetTooLargeMessage, validateSpreadsheetFile, xlsxSpreadsheetValidation } from "@/lib/uploads/spreadsheets";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ id: string }>;
};

export async function DELETE(request: Request, { params }: Params) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "payroll expenses administration");

    const { id } = await params;

    if (!id) {
      return NextResponse.json(
        { error: "missing_report", message: "Expense report id is required." },
        { status: 400 },
      );
    }

    await deletePayrollExpenseReport(id, access);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to delete expense report.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    // An app trip's payroll report, refused for every role before anything was removed.
    if (isWorkflowExpenseReportProtected(error)) {
      return NextResponse.json({ error: "workflow_expense_report", message }, { status: 409 });
    }
    if (isPayrollExpenseReportLocked(error)) {
      return NextResponse.json({ error: "expense_report_locked", message }, { status: 409 });
    }
    if (isPayrollExpenseLockSchemaMissing(error)) {
      return NextResponse.json(
        { error: "payroll_expense_lock_schema_not_ready", message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error: isPayrollExpensesSchemaMissing(error)
          ? "payroll_expenses_schema_not_ready"
          : "expense_report_delete_failed",
        message,
      },
      { status: isPayrollExpensesSchemaMissing(error) ? 503 : 500 },
    );
  }
}

export async function PUT(request: Request, { params }: Params) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "payroll expenses administration");

    const { id } = await params;
    const formData = await request.formData();
    const file = formData.get("file");

    if (!id) {
      return NextResponse.json(
        { error: "missing_report", message: "Expense report id is required." },
        { status: 400 },
      );
    }

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "missing_file", message: "Replacement expenses file is required." },
        { status: 400 },
      );
    }
    const fileValidation = validateSpreadsheetFile(file, {
      ...xlsxSpreadsheetValidation,
      emptyError: "invalid_expenses_file",
      emptyMessage: "Replacement expenses file is empty.",
      tooLargeError: "expenses_file_too_large",
      tooLargeMessage: spreadsheetTooLargeMessage("Replacement expenses file"),
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
          // The Expense Approvals download is refused here, by name, BEFORE the report is cleared —
          // see expense-import.ts.
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

    // A report-replace re-imports trip data; it is never an HR decision. The save clears the
    // report's rows itself, AFTER reading the decisions it is about to overwrite, so a trip kept in
    // the new file keeps whatever HR already decided on it, and a sheet's Status column can never
    // approve a trip. Clearing here first (as this route used to) deletes those decisions before the
    // save can read them. See savePayrollExpenseApprovals' `preserveStoredDecisions` /
    // `replaceReportRowsFirst`.
    const expenses = await savePayrollExpenseApprovals({
      fileName: analysis.fileName,
      records: analysis.records,
      reportId: id,
    }, access, { preserveStoredDecisions: true, replaceReportRowsFirst: id });

    return NextResponse.json({
      ...analysis,
      records: expenses,
      replaced: true,
      saved: expenses.length,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to replace expense report.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    // An app trip's payroll report, refused for every role before anything was removed.
    if (isWorkflowExpenseReportProtected(error)) {
      return NextResponse.json({ error: "workflow_expense_report", message }, { status: 409 });
    }
    if (isPayrollExpenseReportLocked(error)) {
      return NextResponse.json({ error: "expense_report_locked", message }, { status: 409 });
    }
    if (isPayrollExpenseLockSchemaMissing(error)) {
      return NextResponse.json(
        { error: "payroll_expense_lock_schema_not_ready", message },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        error: isPayrollExpensesSchemaMissing(error)
          ? "payroll_expenses_schema_not_ready"
          : "expense_report_replace_failed",
        message,
      },
      { status: isPayrollExpensesSchemaMissing(error) ? 503 : 500 },
    );
  }
}
