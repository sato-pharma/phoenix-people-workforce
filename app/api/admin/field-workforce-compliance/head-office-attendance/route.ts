import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertPageOpenForRole } from "@/lib/auth/seat-page-fences";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getHeadOfficeAttendanceCalendar } from "@/lib/field-workforce-compliance/head-office-attendance";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseMonthYear(url: URL): { month: number; year: number } | null {
  const monthParam = Number(url.searchParams.get("month"));
  const yearParam = Number(url.searchParams.get("year"));
  if (!Number.isInteger(monthParam) || monthParam < 1 || monthParam > 12) return null;
  if (!Number.isInteger(yearParam) || yearParam < 2000 || yearParam > 2100) return null;
  return { month: monthParam, year: yearParam };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_calendar", "read");
    // Fenced off the Talent Acquisition seat with its page (seat-page-fences.ts, audit P7-01).
    assertPageOpenForRole(access.role, "/admin/field-workforce-compliance");

    const parsed = parseMonthYear(new URL(request.url));
    if (!parsed) {
      return NextResponse.json({
        error: "invalid_month_year",
        message: "Provide a valid month (1-12) and year.",
        success: false,
      }, { status: 400 });
    }

    const result = await getHeadOfficeAttendanceCalendar(parsed);

    return NextResponse.json({
      data: result,
      success: true,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({
        error: "forbidden",
        message: "You do not have access to view Head Office attendance.",
        success: false,
      }, { status: 403 });
    }

    return NextResponse.json({
      error: "head_office_attendance_failed",
      message: clientSafeErrorMessage(error, "Head Office attendance could not be loaded."),
      success: false,
    }, { status: 500 });
  }
}
