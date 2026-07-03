import { NextResponse } from "next/server";

import { confirmDigestLines } from "@/lib/attendance/settlement-service";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { id: rawId } = await params;
    const digestId = Number(rawId);
    if (!Number.isInteger(digestId) || digestId <= 0) throw validationError("Invalid digest id.");

    const payload = await request.json();
    const lineIds = Array.isArray((payload as { lineIds?: unknown })?.lineIds)
      ? (payload as { lineIds: unknown[] }).lineIds.map(Number).filter((value) => Number.isInteger(value) && value > 0)
      : [];
    if (lineIds.length === 0) throw validationError("At least one lineId is required.");

    const result = await confirmDigestLines({ actorHrId: access.hrId, digestId, lineIds });
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance digest confirmation failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
