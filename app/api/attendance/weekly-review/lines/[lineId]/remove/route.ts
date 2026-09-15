import { NextResponse } from "next/server";

import { canManageWeeklyReview, removeDigestLine } from "@/lib/attendance/digest-service.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Take one day out of a week that has not been released yet. The employee never sees it. Super Admin only. */
export async function POST(request: Request, { params }: { params: Promise<{ lineId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!canManageWeeklyReview(access)) {
      return NextResponse.json({ error: "forbidden", message: "Only the Super Admin can remove a day." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { lineId: rawLineId } = await params;
    const lineId = Number(rawLineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid day id.");

    const payload = (await request.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof payload.reason === "string" ? payload.reason : "";

    await removeDigestLine({ actorHrId: access.hrId, actorRole: access.role ?? null, lineId, reason });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "The day could not be removed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
