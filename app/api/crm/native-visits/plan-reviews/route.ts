import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { decideNativePlan, listMyNativePlanReviews } from "@/lib/crm/native-visits/plans-service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown, fallback: string) {
  const apiError = toApiError(error, fallback);
  const status = isForbiddenError(error) ? 403 : apiError.status;
  return NextResponse.json(
    { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
    { status },
  );
}

// GET  = weekly plans the signed-in manager's reps sent to that manager, for reps beneath the manager.
// POST = the manager verifies ONE, or returns it with a note. Only the manager the plan was sent to
//        can; the service checks it, and nothing verifies on the manager's behalf.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "approve");
    const rows = await listMyNativePlanReviews(access);
    return NextResponse.json({ rows, success: true });
  } catch (error) {
    return failure(error, "Could not load the plans sent to you.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "approve");
    const body = (await request.json()) as Record<string, unknown>;
    const result = await decideNativePlan(access, {
      decision: body.decision,
      note: body.note,
      planId: body.planId,
      revision: body.revision,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return failure(error, "Could not record your decision.");
  }
}
