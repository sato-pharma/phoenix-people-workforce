import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getIReports360RepDayVisits } from "@/lib/crm/rep-day";
import { loadSingleEmployeeDayPunchSummary } from "@/lib/attendance/punch-minutes";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");
    // Fenced off the Talent Acquisition seat with its page (seat-page-fences.ts, audit P7-01).
    assertPageOpenForRole(access.role, "/admin/field-workforce-compliance");

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
    // Best-effort: a fingerprint-domain hiccup must never break the CRM visits view that
    // already worked fine without it — degrade to null punches rather than fail the request.
    const punches = await loadSingleEmployeeDayPunchSummary({ dateIso: date, hrId }).catch(() => null);
    return NextResponse.json({ data: { date, punches, ...result }, success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to Field Workforce Compliance visits.",
        success: false,
      }, { status: 403 });
    }
    return NextResponse.json({
      error: "field_workforce_visits_failed",
      message: clientSafeErrorMessage(error, "Visit lookup failed."),
      success: false,
    }, { status: 500 });
  }
}
