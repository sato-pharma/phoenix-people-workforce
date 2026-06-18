import { NextResponse } from "next/server";

import {
  isPayrollExpensesSchemaMissing,
  listUnifiedOutstationExpenses,
  listPayrollExpenseReports,
  savePayrollExpenseApprovals,
} from "@/lib/payroll/expenses";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "payroll expenses administration");
    const url = new URL(request.url);
    const rawMonth = url.searchParams.get("month");
    const rawYear = url.searchParams.get("year");
    const month = Number(rawMonth);
    const year = Number(rawYear);
    const reportId = url.searchParams.get("reportId") ?? undefined;
    const hasPeriodFilter = rawMonth !== null || rawYear !== null;

    if (hasPeriodFilter) {
      if (!rawMonth || !rawYear) {
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
    }

    const reports = await listPayrollExpenseReports(access);
    const targetReportId = reportId;
    const expenses = await listUnifiedOutstationExpenses(
      hasPeriodFilter ? month : undefined,
      hasPeriodFilter ? year : undefined,
      targetReportId,
      access,
    );

    return NextResponse.json({ expenses, reports });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load expenses.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json(
      {
        error: isPayrollExpensesSchemaMissing(error) ? "payroll_expenses_schema_not_ready" : "expenses_load_failed",
        message,
      },
      { status: isPayrollExpensesSchemaMissing(error) ? 503 : 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "payroll expenses administration");

    const body = await request.json();
    const fileName = String(body.fileName ?? "expenses-upload.xls");
    const reportId = typeof body.reportId === "string" ? body.reportId : null;
    const records = Array.isArray(body.records) ? body.records : [];

    if (records.length === 0) {
      return NextResponse.json(
        { error: "missing_records", message: "No expenses were provided." },
        { status: 400 },
      );
    }

    const expenses = await savePayrollExpenseApprovals({ fileName, records, reportId }, access);

    return NextResponse.json({ expenses, saved: expenses.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save expense approvals.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    return NextResponse.json(
      {
        error: isPayrollExpensesSchemaMissing(error) ? "payroll_expenses_schema_not_ready" : "expenses_save_failed",
        message,
      },
      { status: isPayrollExpensesSchemaMissing(error) ? 503 : 500 },
    );
  }
}
