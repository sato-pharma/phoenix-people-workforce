import { NextResponse } from "next/server";

import {
  assertCanViewEmployeeAttendance,
  getEmployeeAttendanceData,
} from "@/lib/attendance/employee-attendance";
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

    const callerHrId = access.hrId;
    if (!callerHrId) throw validationError("No HR ID on session.");

    // Default to self; a manager may request a direct report (CEO/Super Admin: anyone).
    const requestedHrId = url.searchParams.get("hrId")?.trim();
    const targetHrId = requestedHrId && requestedHrId.length > 0 ? requestedHrId : callerHrId;
    await assertCanViewEmployeeAttendance(access, targetHrId);

    // Attendance Analytics asks for the working days with no punch at all, shown as "No record"
    // rows; every other reader of this route keeps the rows-only shape.
    const includeNoRecordDays = url.searchParams.get("noRecordDays") === "1";
    return NextResponse.json(await getEmployeeAttendanceData(targetHrId, dateFrom, dateTo, { includeNoRecordDays }));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Employee attendance data failed to load.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
