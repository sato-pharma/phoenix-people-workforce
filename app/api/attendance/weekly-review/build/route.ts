import { NextResponse } from "next/server";

import { buildReviewWeek, canManageWeeklyReview } from "@/lib/attendance/digest-service.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Build a closed week of the current payroll month that the daily job never built, so it can be
 * reviewed. Nothing is sent: the week waits for release like any other. Super Admin only.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!canManageWeeklyReview(access)) {
      return NextResponse.json({ error: "forbidden", message: "Only the Super Admin can build a week." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const payload = (await request.json().catch(() => ({}))) as { cycleKey?: unknown; weekIndex?: unknown };
    const cycleKey = String(payload.cycleKey ?? "");
    if (!/^\d{4}-\d{2}$/.test(cycleKey)) throw validationError("Invalid cycle.");
    const weekIndex = Number(payload.weekIndex);
    if (!Number.isInteger(weekIndex) || weekIndex < 1 || weekIndex > 4) throw validationError("Invalid week.");

    const result = await buildReviewWeek({ actorHrId: access.hrId, actorRole: access.role ?? null, cycleKey, weekIndex });
    return NextResponse.json({ success: true, digestsCreated: result.digestsCreated, linesCreated: result.linesCreated });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "The week could not be built.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
