import { NextResponse } from "next/server";

import { canManageWeeklyReview, markDigestLine } from "@/lib/attendance/digest-service.ts";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tick or untick one flagged day for deduction, and set how many days it deducts, in a week that has
 * not been released yet. Super Admin only (owner, 2026-09-15 — "I want full control").
 */
export async function POST(request: Request, { params }: { params: Promise<{ lineId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "attendance", "read");
    if (!canManageWeeklyReview(access)) {
      return NextResponse.json({ error: "forbidden", message: "Only the Super Admin can choose the days to deduct." }, { status: 403 });
    }
    if (!access.hrId) throw validationError("No HR ID on session.");

    const { lineId: rawLineId } = await params;
    const lineId = Number(rawLineId);
    if (!Number.isInteger(lineId) || lineId <= 0) throw validationError("Invalid day id.");

    const payload = (await request.json().catch(() => ({}))) as { deduct?: unknown; days?: unknown };
    if (typeof payload.deduct !== "boolean") throw validationError("Say whether this day is deducted.");

    const result = await markDigestLine({
      actorHrId: access.hrId,
      actorRole: access.role ?? null,
      lineId,
      deduct: payload.deduct,
      days: payload.days === undefined || payload.days === null ? null : payload.days,
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "The day could not be saved.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
