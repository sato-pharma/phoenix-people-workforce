import { NextResponse } from "next/server";

import { getAttendanceExceptions, saveAttendanceException } from "@/lib/attendance/exceptions";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";

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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const employeeHrId = url.searchParams.get("employeeHrId") ?? undefined;
    const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
    const dateTo = url.searchParams.get("dateTo") ?? undefined;

    return NextResponse.json(
      await getAttendanceExceptions({
        dateFrom,
        dateTo,
        employeeHrId,
        status: status as "all" | "approved" | "pending" | "rejected" | undefined,
      }),
    );
  } catch (error) {
    return apiResponse(error, "Attendance exceptions failed to load.");
  }
}

export async function POST(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw validationError("Exception payload must be an object.");
    }
    const { employeeHrId, exceptionDate, reason, notes, status } = payload as Record<string, unknown>;
    if (!employeeHrId || typeof employeeHrId !== "string") throw validationError("employeeHrId is required.");
    if (!exceptionDate || typeof exceptionDate !== "string") throw validationError("exceptionDate is required.");
    if (!reason || typeof reason !== "string" || !reason.trim()) throw validationError("reason is required.");

    const requestedBy = access.hrId ?? access.loginId ?? "system";

    const result = await saveAttendanceException({
      employeeHrId,
      exceptionDate,
      notes: typeof notes === "string" ? notes : null,
      reason,
      requestedBy,
      status: (status === "approved" || status === "pending" || status === "rejected") ? status : "pending",
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiResponse(error, "Attendance exception failed to save.");
  }
}
