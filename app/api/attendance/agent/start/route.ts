import { NextResponse } from "next/server";

import {
  canManageLocalAttendanceAgent,
  checkAttendanceAgentHealth,
  LocalAttendanceAgentUnsupportedError,
  startLocalAttendanceAgent,
} from "@/lib/attendance/local-agent";
import { assertAttendanceSetupPermission, assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
      { status: 403 },
    );
  }

  const apiError = toApiError(error, fallback);
  return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");
    // Starting the fingerprint agent is Attendance Setup: closed to the salary-blind seat, who
    // holds employees:update for the Employee Master only (owner, 2026-10-20).
    await assertAttendanceSetupPermission(access, "update");

    if (!canManageLocalAttendanceAgent()) {
      return NextResponse.json(
        { error: "attendance_agent_unsupported", message: new LocalAttendanceAgentUnsupportedError().message },
        { status: 501 },
      );
    }

    const before = await checkAttendanceAgentHealth(2500);
    if (before.reachable) {
      return NextResponse.json({ alreadyRunning: true, health: before });
    }

    const started = startLocalAttendanceAgent();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const health = await checkAttendanceAgentHealth(5000);
    return NextResponse.json({ alreadyRunning: false, health, started }, { status: health.reachable ? 200 : 202 });
  } catch (error) {
    return apiResponse(error, "Attendance agent failed to start.");
  }
}
