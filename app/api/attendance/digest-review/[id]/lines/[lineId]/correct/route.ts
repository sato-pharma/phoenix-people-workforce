import { NextResponse } from "next/server";

import { isAuthorizedDisputeReviewer } from "@/lib/attendance/digest-read";
import { correctSettledLine } from "@/lib/attendance/settlement-service";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; lineId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!access.hrId) throw validationError("No HR ID on session.");

    // Coarse pre-check for a clean 403; correctSettledLine re-validates against
    // the same resolved reviewer list independently (defense in depth).
    const authorized = await isAuthorizedDisputeReviewer(access.hrId, access.role === "Super Admin");
    if (!authorized) {
      return NextResponse.json({ error: "forbidden", message: "You are not an authorized digest reviewer." }, { status: 403 });
    }

    const { id: rawId, lineId: rawLineId } = await params;
    const digestId = Number(rawId);
    const lineId = Number(rawLineId);
    if (!Number.isInteger(digestId) || digestId <= 0) throw validationError("Invalid digest id.");
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid line id.");

    const payload = (await request.json().catch(() => ({}))) as {
      deductionDays?: unknown;
      deductionValue?: unknown;
      reason?: unknown;
    };
    const deductionDays = Number(payload.deductionDays);
    const deductionValue = Number(payload.deductionValue);
    if (typeof payload.reason !== "string" || !payload.reason.trim()) {
      throw validationError("A reason is required for a correction.");
    }

    await correctSettledLine({
      actorHrId: access.hrId,
      deductionDays,
      deductionValue,
      digestId,
      lineId,
      reason: payload.reason,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Digest line correction failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
