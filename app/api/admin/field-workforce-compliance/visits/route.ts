import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { IReports360ApiError } from "@/lib/field-workforce-compliance/ireports360-client";
import { isIReports360Configured } from "@/lib/field-workforce-compliance/ireports360-config";
import { getIReports360RepDayVisits } from "@/lib/field-workforce-compliance/ireports360-source";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");

    if (!isIReports360Configured()) {
      return NextResponse.json({
        error: "ireports360_not_configured",
        message: "The iReports360 connection is not configured on the server.",
        success: false,
      }, { status: 503 });
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

    const result = await getIReports360RepDayVisits({ date, hrId });
    return NextResponse.json({ data: { date, ...result }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to Field Workforce Compliance visits.",
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
      error: "field_workforce_visits_failed",
      message: error instanceof Error ? error.message : "Visit lookup failed.",
      success: false,
    }, { status: 500 });
  }
}
