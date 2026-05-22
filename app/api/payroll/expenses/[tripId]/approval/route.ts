import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  isPayrollExpensesSchemaMissing,
  setPayrollExpenseApproval,
} from "@/lib/payroll/expenses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = {
  params: Promise<{ tripId: string }>;
};

export async function POST(request: Request, { params }: Params) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "expenses", "approve");

    const { tripId } = await params;
    const body = await request.json().catch(() => ({})) as {
      comment?: unknown;
      hrApproved?: unknown;
    };

    if (!tripId) {
      return NextResponse.json(
        { error: "missing_trip_id", message: "Expense trip ID is required." },
        { status: 400 },
      );
    }

    const expense = await setPayrollExpenseApproval(tripId, access, {
      comment: body.comment === undefined || body.comment === null ? null : String(body.comment),
      hrApproved: Boolean(body.hrApproved),
    });

    return NextResponse.json({ expense, saved: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save expense approval.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }

    return NextResponse.json(
      {
        error: isPayrollExpensesSchemaMissing(error)
          ? "payroll_expenses_schema_not_ready"
          : "expense_approval_save_failed",
        message,
      },
      { status: isPayrollExpensesSchemaMissing(error) ? 503 : 500 },
    );
  }
}
