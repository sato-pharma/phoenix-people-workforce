import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  isWeeklyPlanRpcError,
  updateEmployeePlan,
  type EmployeePlanItemInput,
} from "@/lib/weekly-planning/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to update plan.";
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
        : "weekly_plan_update_failed",
      message,
      success: false,
    },
    { status: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:") ? 403 : 400 },
  );
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as {
      items?: EmployeePlanItemInput[];
      submit?: boolean;
    };
    const plan = await updateEmployeePlan(access, id, {
      items: Array.isArray(body.items) ? body.items : [],
      submit: body.submit === true,
    });
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
