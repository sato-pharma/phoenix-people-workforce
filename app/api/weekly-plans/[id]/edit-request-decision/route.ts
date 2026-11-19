import { NextResponse } from "next/server";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { decideEditRequest, isWeeklyPlanRpcError } from "@/lib/weekly-planning/service";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const message = clientSafeErrorMessage(error, "Unable to decide edit request.");
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
  return NextResponse.json(
    {
      error: isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")
        ? "forbidden"
        : "weekly_plan_edit_request_decision_failed",
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
    assertSignedIn(access); // REC-080: the caller is judged before the body.
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as {
      decision?: "approve" | "reject";
      comment?: string | null;
    };
    if (body.decision !== "approve" && body.decision !== "reject") {
      return NextResponse.json(
        { error: "invalid_decision", message: "Decision must be 'approve' or 'reject'.", success: false },
        { status: 400 },
      );
    }
    const plan = await decideEditRequest(access, id, {
      comment: body.comment ?? null,
      decision: body.decision,
    });
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
