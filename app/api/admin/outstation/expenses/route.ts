import { NextResponse } from "next/server";

import {
  isPayrollExpensesSchemaMissing,
  listUnifiedOutstationExpenses,
  listPayrollExpenseReports,
  savePayrollExpenseApprovals,
} from "@/lib/outstation/expenses";
import { partitionExpenseApprovalRecords } from "@/lib/outstation/expense-approval-decisions";
import { applyOutstationRequestExpenseDecisions } from "@/lib/outstation/service";
import {
  assertOutstationExpenseApprovalReviewAccess,
  assertSystemAdministratorWorkspaceAccess,
} from "@/lib/auth/permissions";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertValidPayrollPeriod } from "@/lib/payroll/period";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import type { ExpenseTripRecord } from "@/lib/payroll/types";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    // An expired session must not be reported as a missing permission (see
    // api-session-response.ts). A guest is already denied everything, so this only changes
    // how the denial reads, never who gets through.
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    // READ is widened to CEO (2026-08-08) so he can see the claim validation. The decision POST
    // below keeps asserting system-administrator access — reading the queue and moving money are
    // separate privileges here.
    assertOutstationExpenseApprovalReviewAccess(access, "payroll expenses administration");
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
            message: clientSafeErrorMessage(error, "Payroll period is invalid."),
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
    const message = clientSafeErrorMessage(error, "Unable to load expenses.");
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
    // An expired session must not be reported as a missing permission (see
    // api-session-response.ts). A guest is already denied everything, so this only changes
    // how the denial reads, never who gets through.
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;
    assertSystemAdministratorWorkspaceAccess(access, "payroll expenses administration");

    const body = await request.json();
    const fileName = String(body.fileName ?? "expenses-upload.xls");
    const reportId = typeof body.reportId === "string" ? body.reportId : null;
    // Annotated, not inferred: `body` is `any`, and an unannotated `records` makes the generic in
    // `partitionExpenseApprovalRecords` resolve to its own `{ tripId }` constraint — which then
    // fails to satisfy either write path. `savePayrollExpenseApprovals` re-validates the contents.
    const records: Array<
      ExpenseTripRecord & {
        approvedAmount?: number | null;
        hrApproved?: boolean;
        hrComment?: string;
        hrId?: string | null;
        reportId?: string | null;
      }
    > = Array.isArray(body.records) ? body.records : [];

    if (records.length === 0) {
      return NextResponse.json(
        { error: "missing_records", message: "No expenses were provided." },
        { status: 400 },
      );
    }

    // The approvals queue shows imported expense rows and Phoenix-submitted requests in one list,
    // and Save posts them together. They are not written the same way: a request's decision belongs
    // to the outstation workflow (status, evidence gate, notification), not to an upsert into
    // `outstation_expenses` that the next page load would drop.
    const { payrollRecords, requestRecords } = partitionExpenseApprovalRecords(records);

    const requestDecisions =
      requestRecords.length > 0
        ? await applyOutstationRequestExpenseDecisions({ access, entries: requestRecords })
        : { applied: 0, skipped: [] };

    // Nothing left for the payroll path → do not call it at all. It mints an
    // `outstation_expense_reports` row for every save with no report id, so a Save that only
    // decided requests used to leave an empty report behind on each click.
    const expenses =
      payrollRecords.length > 0
        ? await savePayrollExpenseApprovals({ fileName, records: payrollRecords, reportId }, access)
        : [];

    return NextResponse.json({
      expenses,
      requestDecisions,
      saved: expenses.length + requestDecisions.applied,
    });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to save expense approvals.");
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
