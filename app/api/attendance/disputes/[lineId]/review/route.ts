import { NextResponse } from "next/server";

import { isAuthorizedDisputeReviewer } from "@/lib/attendance/digest-read";
import { reviewDigestDispute } from "@/lib/attendance/settlement-service";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ lineId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!access.hrId) throw validationError("No HR ID on session.");

    // Coarse pre-check for a clean 403 before touching the dispute; the service
    // layer re-validates against the same resolved reviewer list independently.
    const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin");
    if (!authorized) {
      return NextResponse.json({ error: "forbidden", message: "You are not an authorized dispute reviewer." }, { status: 403 });
    }

    const { lineId: rawLineId } = await params;
    const lineId = Number(rawLineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid line id.");

    const payload = await request.json();
    const { digestId, decision, notes } = (payload ?? {}) as Record<string, unknown>;
    const parsedDigestId = Number(digestId);
    if (!Number.isInteger(parsedDigestId) || parsedDigestId <= 0) throw validationError("digestId is required.");
    if (decision !== "upheld" && decision !== "rejected") throw validationError("decision must be 'upheld' or 'rejected'.");

    await reviewDigestDispute({
      decision,
      digestId: parsedDigestId,
      lineId,
      notes: typeof notes === "string" && notes.trim() ? notes.trim() : null,
      reviewerHrId: access.hrId,
      reviewerRole: access.role,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Attendance dispute review failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
