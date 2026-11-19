import { NextResponse } from "next/server";
import { z } from "zod";

import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import {
  importApprovedExpensesToPayroll,
  isPayrollExpensesSchemaMissing,
} from "@/lib/outstation/expenses";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { parseJsonBody } from "@/lib/http/request-body";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A month or a year as a number, or as text; the period is still judged below by assertValidPayrollPeriod. */
const periodField = z.union([z.number(), z.string()]).nullable().optional();

/**
 * What the Expenses workspace's "Import to payroll" sends (expenses-review-workspace.tsx): the file name and
 * the period. `records` is accepted only so that unsaved rows are still refused below by name.
 */
const PayrollImportBodySchema = z.object({
  fileName: z.string().nullable().optional(),
  month: periodField,
  records: z.array(z.unknown()).nullable().optional(),
  year: periodField,
});

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "payroll expenses administration");

    const parsedBody = await parseJsonBody(request, PayrollImportBodySchema);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "invalid_request_body", message: parsedBody.message }, { status: 400 });
    }
    const body = parsedBody.data;
    const fileName = String(body.fileName ?? "expenses-upload.xls");
    const month = Number(body.month);
    const year = Number(body.year);
    const rawRecords = Array.isArray(body.records) ? body.records : [];

    if (rawRecords.length > 0) {
      return NextResponse.json(
        {
          error: "unsaved_approval_rows_not_allowed",
          message: "Save manual HR/admin expense approvals before importing to payroll.",
        },
        { status: 400 },
      );
    }

    if (body.month === undefined || body.month === null || body.month === "" || body.year === undefined || body.year === null || body.year === "") {
      return NextResponse.json(
        { error: "missing_period", message: "Payroll month and year are required." },
        { status: 400 },
      );
    }

    try {
      assertValidPayrollPeriod(month, year);
    } catch (error) {
      return NextResponse.json(
        {
          error: "invalid_period",
          message: clientSafeErrorMessage(error, "Payroll period is invalid."),
        },
        { status: 400 },
      );
    }

    const result = await importApprovedExpensesToPayroll({
      fileName,
      month,
      year,
    }, access);

    return NextResponse.json(result);
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to import expenses to payroll.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    if (isPayrollConflictError(error)) {
      return NextResponse.json({ error: "payroll_period_closed", message }, { status: 409 });
    }
    return NextResponse.json(
      {
        error: isPayrollExpensesSchemaMissing(error) ? "payroll_expenses_schema_not_ready" : "expenses_import_failed",
        message,
      },
      { status: isPayrollExpensesSchemaMissing(error) ? 503 : 500 },
    );
  }
}
