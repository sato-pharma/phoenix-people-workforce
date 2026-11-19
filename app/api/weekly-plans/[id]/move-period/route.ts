import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWeeklyPlanRpcError, moveWeeklyPlanToPeriod } from "@/lib/weekly-planning/service";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HR / Super Admin re-dates a whole plan onto a different period, for when an employee picked the
// wrong week in the editor and submitted an otherwise correct plan against it. Authorization, the
// movable-status gate, the destination-period collision check and the item date shift all live in
// the service (moveWeeklyPlanToPeriod). The route asks the first half of that gate, the
// weekly_plans approve grant, before it reads the body: the service opens with the closed legacy
// form's 409 (plans moved) for everyone, so without it a refused role was told which bodies are good.
function jsonError(error: unknown) {
  const message = clientSafeErrorMessage(error, "Unable to move this plan to another period.");
  const lower = message.toLowerCase();
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
  }
  // A signed-out caller (assertSignedIn, REC-080) keeps its 401 rather than the 400 below.
  if (error instanceof ApiError && error.status === 401) {
    return NextResponse.json({ error: error.code, message: error.message, success: false }, { status: 401 });
  }
  if (isForbiddenError(error) || lower.startsWith("forbidden:")) {
    return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
  }
  if (lower.includes("plan was not found")) {
    return NextResponse.json({ error: "not_found", message, success: false }, { status: 404 });
  }
  // Explicit service-layer validation throws are Error instances (400); anything else
  // (e.g. a raw Postgrest failure object) is unexpected (500).
  if (error instanceof Error) {
    return NextResponse.json({ error: "weekly_plan_move_failed", message, success: false }, { status: 400 });
  }
  return NextResponse.json({ error: "weekly_plan_move_failed", message, success: false }, { status: 500 });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    // REC-080: the caller is judged before the body — the approve grant is the first half of moveWeeklyPlanToPeriod's own gate.
    assertSignedIn(access);
    await assertPermission(access, "weekly_plans", "approve");
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { targetAnchorDate?: unknown };
    const targetAnchorDate = typeof body.targetAnchorDate === "string" ? body.targetAnchorDate.trim() : "";
    if (!targetAnchorDate) {
      return NextResponse.json(
        { error: "invalid_period", message: "A target date inside the destination period is required.", success: false },
        { status: 400 },
      );
    }
    const plan = await moveWeeklyPlanToPeriod(access, { planId: id, targetAnchorDate });
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
