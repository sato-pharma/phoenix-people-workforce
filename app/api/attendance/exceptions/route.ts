import { NextResponse } from "next/server";

import { getAttendanceExceptions, saveAttendanceException } from "@/lib/attendance/exceptions";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

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

// Company/system-scoped callers (admins, HR) may read/write any employee's
// exceptions. Everyone else is locked to their own record — otherwise any
// employee with attendance:read could read or dispute a colleague's attendance.
function isPrivilegedScope(scope: string) {
  return scope === "company" || scope === "system";
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const url = new URL(request.url);
    const status = url.searchParams.get("status") ?? undefined;
    const requestedHrId = url.searchParams.get("employeeHrId") ?? undefined;
    const dateFrom = url.searchParams.get("dateFrom") ?? undefined;
    const dateTo = url.searchParams.get("dateTo") ?? undefined;

    // Non-privileged callers can only ever see their own exceptions.
    let employeeHrId = requestedHrId;
    if (!isPrivilegedScope(access.scope)) {
      if (!access.hrId) throw validationError("No HR ID on session.");
      employeeHrId = access.hrId;
    }

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
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");

    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw validationError("Exception payload must be an object.");
    }
    const { employeeHrId, exceptionDate, reason, notes } = payload as Record<string, unknown>;
    if (!exceptionDate || typeof exceptionDate !== "string") throw validationError("exceptionDate is required.");
    if (!reason || typeof reason !== "string" || !reason.trim()) throw validationError("reason is required.");

    // Non-privileged callers can only file a dispute against their own record;
    // privileged callers (admins/HR) may file on behalf of any employee.
    let targetHrId: string;
    if (isPrivilegedScope(access.scope)) {
      if (!employeeHrId || typeof employeeHrId !== "string") throw validationError("employeeHrId is required.");
      targetHrId = employeeHrId;
    } else {
      if (!access.hrId) throw validationError("No HR ID on session.");
      targetHrId = access.hrId;
    }

    const requestedBy = access.hrId ?? access.loginId ?? "system";

    // Creating an exception always starts as a dispute (pending). Approval is a
    // separate, permission-gated review step (PATCH /attendance/exceptions/:id)
    // — never let a create call self-approve.
    const result = await saveAttendanceException({
      employeeHrId: targetHrId,
      exceptionDate,
      notes: typeof notes === "string" ? notes : null,
      reason,
      requestedBy,
      status: "pending",
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiResponse(error, "Attendance exception failed to save.");
  }
}
