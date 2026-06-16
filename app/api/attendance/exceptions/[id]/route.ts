import { NextResponse } from "next/server";

import { deleteAttendanceException, reviewAttendanceException } from "@/lib/attendance/exceptions";
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "update");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("Invalid exception id.");

    const payload = await request.json();
    const { decision, notes } = payload as Record<string, unknown>;
    if (decision !== "approved" && decision !== "rejected") {
      throw validationError("decision must be 'approved' or 'rejected'.");
    }

    const reviewedBy = access.hrId ?? access.loginId ?? "system";
    const result = await reviewAttendanceException({
      decision,
      id,
      notes: typeof notes === "string" ? notes : null,
      reviewedBy,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiResponse(error, "Attendance exception review failed.");
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "delete");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("Invalid exception id.");

    const reviewedBy = access.hrId ?? access.loginId ?? "system";
    await deleteAttendanceException(id, reviewedBy);
    return NextResponse.json({ success: true });
  } catch (error) {
    return apiResponse(error, "Attendance exception deletion failed.");
  }
}
