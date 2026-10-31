import { NextResponse } from "next/server";

import { isNationalSalesManager } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isHrIdInNsmTeamScope } from "@/lib/employee-portal/team-calendar";
import { IReports360ApiError } from "@/lib/crm/client";
import { getIReports360RepDayVisits } from "@/lib/crm/rep-day";
import { loadSingleEmployeeDayPunchSummary } from "@/lib/attendance/punch-minutes";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Portal-scoped twin of /api/admin/field-workforce-compliance/visits. Serves a single
 * rep-day's visit drill-down to a National Sales Manager, but only for a rep inside the
 * NSM's own line (isHrIdInNsmTeamScope). NSMs do not hold the hr_calendar permission the
 * admin route requires, so this is the only visits endpoint the Team Calendar tab uses.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    if (!isNationalSalesManager(access.role)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to the Team Calendar visits.",
        success: false,
      }, { status: 403 });
    }

    const url = new URL(request.url);
    const hrId = (url.searchParams.get("hrId") ?? "").trim();
    const date = (url.searchParams.get("date") ?? "").trim();
    if (!hrId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({
        error: "invalid_params",
        message: "Provide hrId and a date as YYYY-MM-DD.",
        success: false,
      }, { status: 400 });
    }

    if (!(await isHrIdInNsmTeamScope(access, hrId))) {
      return NextResponse.json({
        error: "forbidden",
        message: "This rep is not in your line.",
        success: false,
      }, { status: 403 });
    }

    // Read together (2026-10-31, "fix the slowest five pages"): neither needs the other.
    const [result, punches] = await Promise.all([
      getIReports360RepDayVisits({ date, hrId }),
      // Best-effort: a fingerprint-domain hiccup must never break the CRM visits view that
      // already worked fine without it — degrade to null punches rather than fail the request.
      loadSingleEmployeeDayPunchSummary({ dateIso: date, hrId }).catch(() => null),
    ]);
    return NextResponse.json({ data: { date, punches, ...result }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to the Team Calendar visits.",
        success: false,
      }, { status: 403 });
    }
    if (error instanceof IReports360ApiError) {
      return NextResponse.json({
        error: "ireports360_request_failed",
        message: error.message,
        success: false,
      }, { status: error.status });
    }
    return NextResponse.json({
      error: "team_calendar_visits_failed",
      message: clientSafeErrorMessage(error, "Visit lookup failed."),
      success: false,
    }, { status: 500 });
  }
}
