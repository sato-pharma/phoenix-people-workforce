import { NextResponse } from "next/server";
import { z } from "zod";

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

const optionalCoercedPayrollPeriodValue = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? undefined : value),
  z.coerce.number().int().optional(),
);

const safeString = z.preprocess(
  (value) => (value === null || value === undefined ? "" : value),
  z.string(),
);

const expenseTripRecordSchema = z.object({
  allowance: z.coerce.number(),
  amWorkload: z.coerce.number(),
  date: safeString,
  description: safeString,
  from: safeString,
  hr: safeString,
  hrId: z.string().min(1).nullable().optional(),
  hrNotes: safeString,
  km: z.coerce.number(),
  location: safeString,
  meetingAmount: z.coerce.number(),
  open: safeString,
  pmWorkload: z.coerce.number(),
  requestType: safeString,
  row: z.coerce.number().int(),
  specialist: safeString,
  status: safeString,
  to: safeString,
  toDate: safeString,
  total: z.coerce.number(),
  transportationType: safeString,
  travelCost: z.coerce.number(),
  tripId: safeString,
  tripType: safeString,
  hrApproved: z.boolean().optional(),
  hrComment: safeString.optional(),
});

const payrollExpensesImportBodySchema = z.object({
  fileName: z.string().optional(),
  month: optionalCoercedPayrollPeriodValue,
  records: z.array(expenseTripRecordSchema).optional(),
  year: optionalCoercedPayrollPeriodValue,
});

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "expenses", "import");

    const parsedBody = payrollExpensesImportBodySchema.safeParse(await request.json());
    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "invalid_request", message: "Invalid expenses import payload." },
        { status: 400 },
      );
    }

    const fileName = parsedBody.data.fileName ? parsedBody.data.fileName : "expenses-upload.xls";
    const month = parsedBody.data.month;
    const year = parsedBody.data.year;
    const records = parsedBody.data.records ?? [];

    if (month === undefined || year === undefined) {
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
      records: records.length > 0 ? records : undefined,
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
