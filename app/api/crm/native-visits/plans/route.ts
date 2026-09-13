import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getMyNativePlanner, saveMyNativePlan } from "@/lib/crm/native-visits/plans-service";
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

// GET  = the signed-in rep's own planner: the open pilot weeks, the rep's doctors, what is planned.
// POST = save, submit or reopen ONE week of the rep's own plan. The rep is always the session.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "create");
    const planner = await getMyNativePlanner(access);
    return NextResponse.json({ planner, success: true });
  } catch (error) {
    return failure(error, "Could not load your plan.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "create");
    const body = (await request.json()) as Record<string, unknown>;
    const result = await saveMyNativePlan(access, {
      action: body.action,
      items: body.items,
      revision: body.revision,
      weekStart: body.weekStart,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return failure(error, "Could not save your plan.");
  }
}
