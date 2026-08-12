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
import { logAppError } from "@/lib/error-monitor/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What was actually thrown, in words.
 *
 * NOT every throw is an Error. Supabase hands back a plain `{ message, details, hint, code }` and
 * this codebase rethrows it as-is, so `String(error)` yields the useless "[object Object]" — which
 * is exactly what the first version of this logging recorded on 2026-08-12, turning a captured
 * error into a captured shrug. Own properties are enumerated so a PostgrestError's `code` and
 * `details` survive, and JSON.stringify is guarded because a cyclic throw must not replace one
 * unreadable log line with a second failure.
 */
function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error, Object.getOwnPropertyNames(error));
    } catch {
      return Object.getOwnPropertyNames(error)
        .map((key) => `${key}=${String((error as Record<string, unknown>)[key])}`)
        .join(" ");
    }
  }
  return String(error);
}

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
