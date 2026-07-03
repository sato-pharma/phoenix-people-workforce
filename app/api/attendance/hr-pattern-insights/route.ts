import { NextResponse } from "next/server";

import { getHrPatternInsights } from "@/lib/attendance/hr-pattern-insights";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function defaultDateFrom() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - 90);
  return date.toISOString().slice(0, 10);
}

function defaultDateTo() {
  return new Date().toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "read");

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("dateFrom") ?? defaultDateFrom();
    const dateTo = url.searchParams.get("dateTo") ?? defaultDateTo();

    return NextResponse.json(await getHrPatternInsights(dateFrom, dateTo));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "HR pattern insights failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
