import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import {
  importApprovedExpensesToPayroll,
  isPayrollExpensesSchemaMissing,
} from "@/lib/payroll/expenses";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "expenses", "import");

    const body = await request.json();
    const fileName = String(body.fileName ?? "expenses-upload.xls");
    const month = Number(body.month);
    const year = Number(body.year);

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
          message: error instanceof Error ? error.message : "Payroll period is invalid.",
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
    const message = error instanceof Error ? error.message : "Unable to import expenses to payroll.";
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
