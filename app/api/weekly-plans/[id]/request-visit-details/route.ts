import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isWeeklyPlanRpcError, requestVisitDetails } from "@/lib/weekly-planning/service";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown) {
  const message = clientSafeErrorMessage(error, "Unable to request visit details.");
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
  }
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  // A signed-out caller (assertSignedIn, REC-080) keeps its 401 rather than the 400 below.
  if (error instanceof ApiError && error.status === 401) {
    return NextResponse.json({ error: error.code, message: error.message, success: false }, { status: 401 });
  }
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "request_visit_details_failed", message, success: false },
    { status: forbidden ? 403 : 400 },
  );
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    // REC-080: the legacy form answers 409 (plans moved) to everyone, so the caller is judged first: a
    // signed-out caller gets 401 and a role without weekly_plans:approve gets 403; anyone holding it still
    // reaches the 409.
    assertSignedIn(access);
    await assertPermission(access, "weekly_plans", "approve");
    const { id } = await context.params;
    const plan = await requestVisitDetails(access, id);
    return NextResponse.json({ data: plan, success: true });
  } catch (error) {
    return jsonError(error);
  }
}
