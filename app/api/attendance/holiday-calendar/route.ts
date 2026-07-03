import { NextResponse } from "next/server";

import { bulkUpsertHolidayOverrides, buildHolidayCalendarYearView, type HolidayOverrideInput } from "@/lib/attendance/holiday-overrides";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function currentYear() {
  return new Date().getUTCFullYear();
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "read");

    const url = new URL(request.url);
    const yearParam = Number(url.searchParams.get("year"));
    const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= 2100 ? yearParam : currentYear();

    return NextResponse.json({ year, ...(await buildHolidayCalendarYearView(year)) });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Holiday calendar failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "update");

    const payload = (await request.json()) as { entries?: HolidayOverrideInput[] };
    if (!Array.isArray(payload.entries)) {
      return NextResponse.json({ error: "validation", message: "entries must be an array." }, { status: 400 });
    }

    return NextResponse.json(await bulkUpsertHolidayOverrides(payload.entries, access.hrId));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Bulk holiday calendar save failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
