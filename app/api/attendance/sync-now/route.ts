import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError, toApiError } from "@/lib/http/api-errors";
import { attendanceAgentToken, attendanceAgentUrl, ensureLocalAttendanceAgent } from "@/lib/attendance/local-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiResponse(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden." },
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

    try {
      attendanceAgentToken();
    } catch {
      throw new ApiError(500, "attendance_agent_token_missing", "ATTENDANCE_AGENT_TOKEN is required.");
    }

    const agent = await ensureLocalAttendanceAgent();
    if (!agent.health.reachable) {
      return NextResponse.json(
        {
          error: "attendance_agent_unreachable",
          message: `Local attendance agent could not be started at ${attendanceAgentUrl("").toString()}.`,
          agent,
        },
        { status: 503 },
      );
    }

    const response = await fetch(attendanceAgentUrl("sync-now"), {
      body: "{}",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${attendanceAgentToken()}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(600_000),
    });

    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { message: text };
    }

    return NextResponse.json(payload, { status: response.status });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return NextResponse.json(
        {
          error: "attendance_agent_timeout",
          message: "Attendance agent sync timed out while reading the fingerprint device.",
        },
        { status: 504 },
      );
    }

    if (error instanceof TypeError && error.message.toLowerCase().includes("fetch failed")) {
      return NextResponse.json(
        {
          error: "attendance_agent_unreachable",
          message: `Local attendance agent is not reachable at ${attendanceAgentUrl("").toString()}. Start local-attendance-agent\\start-agent.ps1, then try Sync Now again.`,
        },
        { status: 503 },
      );
    }

    return apiResponse(error, "Attendance sync failed.");
  }
}
