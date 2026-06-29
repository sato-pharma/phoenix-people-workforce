import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWeeklyPlanRpcError, submitVisitDetails, type VisitDetailInput } from "@/lib/weekly-planning/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to submit visit details.";
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
  }
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "submit_visit_details_failed", message, success: false },
    { status: forbidden ? 403 : 400 },
  );
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { details?: VisitDetailInput[] };
    if (!Array.isArray(body.details) || body.details.length === 0) {
      return NextResponse.json(
        { error: "validation_error", message: "At least one visit detail entry is required.", success: false },
        { status: 400 },
      );
    }
    const plan = await submitVisitDetails(access, id, body.details);
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
