import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { addPlanComment, isWeeklyPlanRpcError, listPlanComments } from "@/lib/weekly-planning/service";
import { ApiError, clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  // The legacy form is closed (legacy-closed.ts): a refused comment says so, with its own status.
  if (isWeeklyPlanRpcError(error)) {
    return NextResponse.json(
      { error: `weekly_plan_${error.code}`, message: error.message, success: false },
      { status: error.status },
    );
  }
  const message = clientSafeErrorMessage(error, fallback);
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  // A signed-out caller (assertSignedIn, REC-080) keeps its 401 rather than the 400 below.
  if (error instanceof ApiError && error.status === 401) {
    return NextResponse.json({ error: error.code, message: error.message, success: false }, { status: 401 });
  }
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "plan_comment_error", message, success: false },
    { status: forbidden ? 403 : 400 },
  );
}

// Two-way plan conversation: anyone who can view the plan (submitter, assigned
// manager, CEO, HR/Super Admin at the final stages) can read and post here,
// independent of the plan's current status.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const result = await listPlanComments(access, id);
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return jsonError(error, "Unable to load plan conversation.");
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    // REC-080: the legacy form answers 409 (plans moved) to everyone, so the caller is judged first: a
    // signed-out caller gets 401 and a role without weekly_plans:read gets 403; anyone holding it still
    // reaches the 409.
    assertSignedIn(access);
    await assertPermission(access, "weekly_plans", "read");
    const { id } = await context.params;
    const body = await request.json().catch(() => ({})) as {
      body?: string;
      itemId?: string | null;
      parentId?: string | null;
    };
    const comment = await addPlanComment(access, id, {
      body: body.body ?? "",
      itemId: body.itemId ?? null,
      parentId: body.parentId ?? null,
    });
    return NextResponse.json({ data: comment, success: true });
  } catch (error) {
    return jsonError(error, "Unable to post plan comment.");
  }
}
