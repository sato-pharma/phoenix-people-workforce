import { NextResponse } from "next/server";

import { deleteAttendancePolicy, getAttendancePolicyDashboard, saveAttendancePolicy } from "@/lib/attendance/policies";
import { assertAttendanceSetupPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

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

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "read");

    return NextResponse.json(await getAttendancePolicyDashboard());
  } catch (error) {
    return apiResponse(error, "Attendance policies failed to load.");
  }
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "update");

    const payload = await request.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw validationError("Policy payload must be an object.");
    }

    await saveAttendancePolicy(payload as Parameters<typeof saveAttendancePolicy>[0]);
    return NextResponse.json(await getAttendancePolicyDashboard());
  } catch (error) {
    return apiResponse(error, "Attendance policy failed to save.");
  }
}

export async function DELETE(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertAttendanceSetupPermission(access, "update");

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (!id) throw validationError("Policy id is required.");

    await deleteAttendancePolicy({ id });
    return NextResponse.json(await getAttendancePolicyDashboard());
  } catch (error) {
    return apiResponse(error, "Attendance policy failed to delete.");
  }
}
