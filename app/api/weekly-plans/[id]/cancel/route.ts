import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { cancelEmployeePlan, isWeeklyPlanRpcError } from "@/lib/weekly-planning/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const message = clientSafeErrorMessage(error, "Unable to cancel plan.");
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
  }
  return NextResponse.json(
    {
      error: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")
        ? "forbidden"
        : "weekly_plan_cancel_failed",
      message,
      success: false,
    },
    { status: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:") ? 403 : 400 },
  );
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as { comment?: string | null };
    const plan = await cancelEmployeePlan(access, id, body.comment ?? null);
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
