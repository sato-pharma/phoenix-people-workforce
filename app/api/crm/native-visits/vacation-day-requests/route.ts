import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  assertVacationDayAccess,
  cancelVacationDayRequest,
  decideVacationDayRequest,
  listVacationDayRequests,
  requestVacationDayWork,
} from "@/lib/crm/native-visits/vacation-days";
import { toApiError, validationError } from "@/lib/http/api-errors";
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

// GET  = the signed-in person's own requests, and the ones waiting for his answer as manager or HR.
// POST = action "request" (the rep asks for one of his own vacation days), "decide" (the stored
//        manager, or HR, answers one) or "cancel" (the rep withdraws his own). The person is always
//        the session; each service function checks its own permission and scope.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertVacationDayAccess(access);
    const view = await listVacationDayRequests(access);
    return NextResponse.json({ view, success: true });
  } catch (error) {
    return failure(error, "Could not load vacation-day requests.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertVacationDayAccess(access);
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === "request") {
      const result = await requestVacationDayWork(access, { visitDate: body.visitDate, reason: body.reason });
      return NextResponse.json({ ...result, success: true });
    }
    if (body.action === "decide") {
      const result = await decideVacationDayRequest(access, {
        requestId: body.requestId,
        as: body.as,
        decision: body.decision,
        note: body.note,
      });
      return NextResponse.json({ ...result, success: true });
    }
    if (body.action === "cancel") {
      const result = await cancelVacationDayRequest(access, { requestId: body.requestId });
      return NextResponse.json({ ...result, success: true });
    }
    throw validationError("Choose what to do with the request.");
  } catch (error) {
    return failure(error, "Could not save that.");
  }
}
