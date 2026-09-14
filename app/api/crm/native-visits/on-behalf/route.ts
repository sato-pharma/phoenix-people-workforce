import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { createNativeVisit, getNativeVisitFormOptions } from "@/lib/crm/native-visits/service";
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

// The Super Admin enters a visit FOR a rep (the owner, 2026-09-14) — the one visit route where the rep
// comes from the request. crm_visit_entry `update` gates it here and again in the service, which
// accepts only an active medical rep inside the caller's scope.
// GET  ?repHrId=           = what the form offers for that rep: his open days up to today, his doctors, his managers.
// POST { repHrId, visit }  = save one visit for that rep, with no location. The rep is told in-app.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "update");
    const repHrId = new URL(request.url).searchParams.get("repHrId");
    const options = await getNativeVisitFormOptions(access, { repHrId });
    return NextResponse.json({ options, success: true });
  } catch (error) {
    return failure(error, "Could not load the visit form for that rep.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "crm_visit_entry", "update");
    const body = ((await request.json().catch(() => null)) ?? {}) as { repHrId?: unknown; visit?: unknown };
    const result = await createNativeVisit(access, body.visit, { repHrId: body.repHrId });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    return failure(error, "Could not save the visit.");
  }
}
