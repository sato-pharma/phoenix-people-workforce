import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listPhoenixCrmPilotRoster, setPhoenixCrmPilotRep } from "@/lib/crm/native-visits/phoenix-crm";
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

// The Phoenix CRM pilot roster (the owner, 2026-09-14): the Super Admin picks the medical reps who work
// in Phoenix CRM, from any line, and adds or removes one on any day. crm_visit_entry `update` gates it
// here and again in the service, which accepts only an active medical rep inside the caller's scope.
// GET                        = every active medical rep in scope, and whether each is on the roster.
// POST { repHrId, action }   = "add" puts the rep on the roster from today; "remove" takes the rep off.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "update");
    const view = await listPhoenixCrmPilotRoster(access);
    return NextResponse.json({ view, success: true });
  } catch (error) {
    return failure(error, "Could not load the pilot reps.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "update");
    const body = ((await request.json().catch(() => null)) ?? {}) as { repHrId?: unknown; action?: unknown };
    const view = await setPhoenixCrmPilotRep(access, { repHrId: body.repHrId, action: body.action });
    return NextResponse.json({ view, success: true });
  } catch (error) {
    return failure(error, "Could not change the pilot reps.");
  }
}
