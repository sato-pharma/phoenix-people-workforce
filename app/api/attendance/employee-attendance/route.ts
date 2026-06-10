import { NextResponse } from "next/server";

import { getEmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const url = new URL(request.url);
    const dateFrom = url.searchParams.get("dateFrom");
    const dateTo = url.searchParams.get("dateTo");

    if (!dateFrom || !dateTo) throw validationError("dateFrom and dateTo are required.");

    // Employees can only read their own data (scope = self).
    const hrId = access.hrId;
    if (!hrId) throw validationError("No HR ID on session.");

    return NextResponse.json(await getEmployeeAttendanceData(hrId, dateFrom, dateTo));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Employee attendance data failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
