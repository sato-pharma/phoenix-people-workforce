import { NextResponse } from "next/server";

import { readAttendanceExceptionNotes } from "@/lib/attendance/exception-notes";
import { deleteAttendanceException, reviewAttendanceException } from "@/lib/attendance/exceptions";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "attendance exception administration");

    const { id: rawId } = await params;
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0) throw validationError("Invalid exception id.");

    const payload = await request.json();
    const { decision } = payload as Record<string, unknown>;
    if (decision !== "approved" && decision !== "rejected") {
      throw validationError("decision must be 'approved' or 'rejected'.");
    }

    // A bare string-or-null coercion used to live here, which flattened a body that never
    // mentioned notes into an explicit "clear it" before the service could tell the difference.
    // The reviewer's note and the requester's note share one column.
    const reviewedBy = access.hrId ?? access.loginId ?? "system";
    const result = await reviewAttendanceException({
      decision,
      id,
      notes: readAttendanceExceptionNotes(payload as Record<string, unknown>),
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
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertSystemAdministratorWorkspaceAccess(access, "attendance exception administration");

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
