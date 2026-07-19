import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWeeklyPlanRpcError, reassignWeeklyPlanManager } from "@/lib/weekly-planning/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HR / Super Admin re-routes a stuck weekly/monthly plan to a new active manager when the
// assigned manager resigned before deciding. Authorization + status guards live in the service
// (reassignWeeklyPlanManager): this only changes WHO owns the pending manager step, never decides
// the plan in place.
function jsonError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to reassign plan approver.";
  const lower = message.toLowerCase();
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
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
    return NextResponse.json({ error: "weekly_plan_reassign_failed", message, success: false }, { status: 400 });
  }
  return NextResponse.json({ error: "weekly_plan_reassign_failed", message, success: false }, { status: 500 });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { newManagerHrId?: unknown };
    const newManagerHrId = typeof body.newManagerHrId === "string" ? body.newManagerHrId.trim() : "";
    if (!newManagerHrId) {
      return NextResponse.json(
        { error: "invalid_manager", message: "A new manager is required.", success: false },
        { status: 400 },
      );
    }
    const plan = await reassignWeeklyPlanManager(access, { newManagerHrId, planId: id });
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
