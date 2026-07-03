import { NextResponse } from "next/server";

import { submitDigestDispute } from "@/lib/attendance/settlement-service";
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
    const { lineId, reason, attachmentUrl } = (payload ?? {}) as Record<string, unknown>;
    const parsedLineId = Number(lineId);
    if (!Number.isInteger(parsedLineId) || parsedLineId <= 0) throw validationError("lineId is required.");
    if (typeof reason !== "string" || !reason.trim()) throw validationError("A dispute reason is required.");

    const line = await submitDigestDispute({
      actorHrId: access.hrId,
      attachmentUrl: typeof attachmentUrl === "string" && attachmentUrl.trim() ? attachmentUrl.trim() : null,
      digestId,
      lineId: parsedLineId,
      reason,
    });
    return NextResponse.json({ line });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance dispute failed to submit.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
