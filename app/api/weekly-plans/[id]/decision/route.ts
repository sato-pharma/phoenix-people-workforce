import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  decideEmployeePlan,
  isWeeklyPlanRpcError,
  type EmployeePlanReturnNoteInput,
} from "@/lib/weekly-planning/service";
import type { EmployeePlanAction } from "@/lib/weekly-planning/plan-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const decisionActions = new Set<EmployeePlanAction>([
  "manager_approve",
  "manager_reject",
  "manager_return",
  "ceo_approve",
  "ceo_reject",
  "ceo_return",
]);

function jsonError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to decide plan.";
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
        : "weekly_plan_decision_failed",
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
    const body = await request.json().catch(() => ({})) as {
      action?: EmployeePlanAction;
      comment?: string | null;
      returnNotes?: EmployeePlanReturnNoteInput[];
    };
    if (!body.action || !decisionActions.has(body.action)) {
      return NextResponse.json(
        { error: "invalid_action", message: "Plan decision action is invalid.", success: false },
        { status: 400 },
      );
    }
    const plan = await decideEmployeePlan(access, id, {
      action: body.action as Extract<EmployeePlanAction, "manager_approve" | "manager_reject" | "manager_return" | "ceo_approve" | "ceo_reject" | "ceo_return">,
      comment: body.comment,
      returnNotes: Array.isArray(body.returnNotes) ? body.returnNotes : [],
    });
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
