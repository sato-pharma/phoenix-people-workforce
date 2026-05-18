import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError, toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const defaultAgentUrl = "http://127.0.0.1:8787";

function agentUrl(path: string) {
  const baseUrl = process.env.ATTENDANCE_AGENT_LOCAL_URL?.trim() || defaultAgentUrl;
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function attendanceAgentToken() {
  const token = process.env.ATTENDANCE_AGENT_TOKEN?.trim();
  if (!token) {
    throw new ApiError(500, "attendance_agent_token_missing", "ATTENDANCE_AGENT_TOKEN is required.");
  }
  return token;
}

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

    const response = await fetch(agentUrl("sync-now"), {
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

    return apiResponse(error, "Attendance sync failed.");
  }
}
