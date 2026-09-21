import { NextResponse } from "next/server";

import {
  isPayrollExpensesSchemaMissing,
  listUnifiedOutstationExpenses,
  listPayrollExpenseReports,
  savePayrollExpenseApprovals,
} from "@/lib/outstation/expenses";
import { partitionExpenseApprovalRecords } from "@/lib/outstation/expense-approval-decisions";
import {
  describeWorkflowTripIdRefusal,
  findRowsCarryingWorkflowTripIds,
} from "@/lib/outstation/workflow-trip-id-guard";
import { describeExpenseResyncNotApplied, type ExpenseResyncOutcome } from "@/lib/automated-payroll/expense-resync";
import { applyOutstationRequestExpenseDecisions } from "@/lib/outstation/service";
import { expenseClaimsReadEnabled } from "@/lib/outstation/claims-read-flag";
import { refreshExpenseClaims } from "@/lib/outstation/claims-refresh";
import { logError } from "@/lib/observability/log";
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
import { logAppError } from "@/lib/error-monitor/service";
// Was a private copy in this file (#2062). Shared now because instrumentation.ts's app-wide
// onRequestError needed the identical logic and had kept the broken `String(error)` version —
// one route was fixed while the net under all of them still recorded "[object Object]".
import { describeThrown } from "@/lib/error-monitor/describe-thrown";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Hoisted so the catch below can attribute the failure to a person, the same reason
  // /api/marketing-requests/drafts hoists it. While this was scoped inside the `try`, every row
  // this route logged was anonymous — the 16 rows it wrote on 2026-08-12 name nobody, which is
  // most of the value of having captured them at all.
  let access: Awaited<ReturnType<typeof resolveAccessContext>> | null = null;
  try {
    access = await resolveAccessContext(request);
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
    // The legacy tables, never the `expense_claims` mirror: both screens on this route SAVE to those
    // tables, so they must read back what they wrote (see `readLegacyTables`).
    const expenses = await listUnifiedOutstationExpenses(
      hasPeriodFilter ? month : undefined,
      hasPeriodFilter ? year : undefined,
      targetReportId,
      access,
      { readLegacyTables: true },
    );

    return NextResponse.json({ expenses, reports });
  } catch (error) {
    const message = clientSafeErrorMessage(error, "Unable to load expenses.");
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message }, { status: 403 });
    }
    // ── The 500 has to leave a trace (2026-08-12) ──────────────────────────────────────────────
    //
    // This route caught its own error and returned a client-safe message, so the REAL cause went
    // nowhere: not to app_error_events, and not to instrumentation.ts's onRequestError either,
    // because that only fires on errors the handler lets escape. When this endpoint started
    // returning 500 in production, the hourly synthetic smoke could say THAT it was broken and
    // nothing anywhere could say WHY — the message the client sees is deliberately sanitised, and
    // it is the only thing that survived.
    //
    // `clientSafeErrorMessage` still guards what the caller is told. This records the unsanitised
    // message and stack where an operator can read them, which is the whole point of having an
    // error table. Awaited rather than fired-and-forgotten: the response is already failing, and a
    // dropped log on the one path that needs it is how this happened in the first place.
    await logAppError({
      source: "server",
      route: "/api/admin/outstation/expenses",
      routeType: "route-handler",
      hrId: access?.hrId ?? null,
      loginId: access?.loginId ?? null,
      role: access?.role ?? null,
      message: describeThrown(error),
      stack: error instanceof Error ? (error.stack ?? null) : null,
    }).catch(() => {
      // Never let the logger turn a 500 into a crash. If it cannot write, the response still goes.
    });
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

    // An id in the workflow's reserved namespace that is not a request's exact id (`outstation-72`,
    // `OUTSTATION - 72`) falls to the payroll save, which refuses it — but only AFTER the request
    // decisions below were committed. Refuse it here, before anything is written, as a 400.
    const reservedRows = findRowsCarryingWorkflowTripIds(payrollRecords);
    if (reservedRows.length > 0) {
      return NextResponse.json(
        { error: "workflow_trip_id_refused", message: describeWorkflowTripIdRefusal(reservedRows) },
        { status: 400 },
      );
    }

    const requestDecisions =
      requestRecords.length > 0
        ? await applyOutstationRequestExpenseDecisions({ access, entries: requestRecords })
        : { applied: 0, skipped: [] };

    // Nothing left for the payroll path → do not call it at all. It mints an
    // `outstation_expense_reports` row for every save with no report id, so a Save that only
    // decided requests used to leave an empty report behind on each click.
    // What the payroll resync did with these decisions. One that did NOT reach an open run is said out
    // loud in `payrollWarnings`, rather than hidden behind "Approvals saved" (audit finding 47).
    let payrollResync: ExpenseResyncOutcome[] = [];
    const expenses =
      payrollRecords.length > 0
        ? await savePayrollExpenseApprovals({ fileName, records: payrollRecords, reportId }, access, {
            onPayrollResync: (outcomes) => {
              payrollResync = outcomes;
            },
          })
        : [];

    // Every other expense screen (the approvals hub, the command centre, the dashboards) still reads
    // the `expense_claims` mirror, which otherwise shows this decision only after its next scheduled
    // rebuild. The rebuild is idempotent and takes under a second, so run it now. It never fails the
    // save: the decision is already committed, and the schedule remains the backstop.
    if (expenseClaimsReadEnabled() && expenses.length + requestDecisions.applied > 0) {
      try {
        const refresh = await refreshExpenseClaims();
        if (refresh.status === "blocked") {
          logError("Expense claims refresh after an approvals save was refused by an interlock", {
            labels: { event: "expense_claims_refresh_after_save_blocked" },
            error: new Error(refresh.reason),
          });
        }
      } catch (refreshError) {
        logError("Expense claims refresh after an approvals save failed", {
          labels: { event: "expense_claims_refresh_after_save_failed" },
          error: refreshError instanceof Error ? refreshError : new Error(describeThrown(refreshError)),
        });
      }
    }

    return NextResponse.json({
      expenses,
      requestDecisions,
      saved: expenses.length + requestDecisions.applied,
      payrollWarnings: describeExpenseResyncNotApplied(payrollResync),
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
