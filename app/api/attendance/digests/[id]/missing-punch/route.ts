import { NextResponse } from "next/server";

import { submitMissingPunchReason } from "@/lib/attendance/missing-punch-verification";
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

    // digestId (from the URL) is accepted for a stable, self-documenting route
    // shape, but ownership is enforced against the digest LINE's own digest in
    // the service — the lineId is the actual authority.
    void (await params).id;

    const payload = await request.json();
    const { lineId, reason, proofUrl } = (payload ?? {}) as Record<string, unknown>;
    const parsedLineId = Number(lineId);
    if (!Number.isInteger(parsedLineId) || parsedLineId <= 0) throw validationError("lineId is required.");
    if (typeof reason !== "string" || !reason.trim()) throw validationError("A reason is required.");

    const verification = await submitMissingPunchReason({
      actorHrId: access.hrId,
      digestLineId: parsedLineId,
      proofUrl: typeof proofUrl === "string" && proofUrl.trim() ? proofUrl.trim() : null,
      reason,
    });
    return NextResponse.json({ verification });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Missing-punch reason failed to submit.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
