import { NextResponse } from "next/server";

import { assertAttendanceSetupPermission, assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError, clientSafeErrorMessage, toApiError } from "@/lib/http/api-errors";
import {
  attendanceAgentToken,
  attendanceAgentUrl,
  canManageLocalAttendanceAgent,
  ensureLocalAttendanceAgent,
  LocalAttendanceAgentUnsupportedError,
} from "@/lib/attendance/local-agent";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSyncAlreadyRunning(payload: unknown) {
  if (!isRecord(payload)) return false;

  const message = typeof payload.message === "string" ? payload.message : "";
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  return [message, ...errors].some(
    (value) => typeof value === "string" && value.toLowerCase().includes("attendance sync is already running"),
  );
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "update");
    // The machine sync is Attendance Setup: closed to the salary-blind seat, who holds
    // employees:update for the Employee Master only (owner, 2026-10-20).
    await assertAttendanceSetupPermission(access, "update");

    if (!canManageLocalAttendanceAgent()) {
      // On Linux/Cloud Run production there is no localhost PowerShell agent to trigger;
      // ingestion is push-based via /api/attendance/raw-punches. Fail clearly (501),
      // never attempt to spawn powershell.exe.
      return NextResponse.json(
        { error: "attendance_agent_unsupported", message: new LocalAttendanceAgentUnsupportedError().message },
        { status: 501 },
      );
    }

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

    if (response.status === 409 && isSyncAlreadyRunning(payload)) {
      return NextResponse.json(
        {
          ...(isRecord(payload) ? payload : {}),
          failed: 0,
          message: "Attendance sync is already running.",
          syncInProgress: true,
        },
        { status: 202 },
      );
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
