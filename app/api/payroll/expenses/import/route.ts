import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
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
    const records = Array.isArray(body.records) ? body.records : [];

    if (!month || !year) {
      return NextResponse.json(
        { error: "missing_period", message: "Payroll month and year are required." },
        { status: 400 },
      );
    }

    const result = await importApprovedExpensesToPayroll({
      fileName,
      month,
      records: records.length > 0 ? records : undefined,
      year,
    }, access);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to import expenses to payroll.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
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
