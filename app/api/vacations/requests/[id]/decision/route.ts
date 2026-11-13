import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ApiError } from "@/lib/http/api-errors";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  decideVacationRequest,
  isVacationSchemaMissing,
  parseVacationDecision,
  vacationErrorMessage,
} from "@/lib/vacation/service";
import { assertVacationRouteRateLimit } from "@/lib/vacation/route-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    await assertVacationRouteRateLimit({
      actor: access.loginId ?? access.hrId,
      limit: 30,
      request,
      scope: "vacation:decision",
      windowMs: 60_000,
    });
    const body = await request.json();
    const decision = parseVacationDecision(body.decision);
    if (!decision) {
      return NextResponse.json({ error: "invalid_decision", message: "Vacation decision is invalid.", success: false }, { status: 400 });
    }

    const result = await decideVacationRequest(access, {
      decision,
      decisionComment: body.decisionComment,
      // Stalled-approver override. Strict === true so a truthy string from a hand-rolled client
      // cannot switch it on; the service re-checks Super Admin and the elapsed wait regardless.
      override: body.override === true,
      requestId: id,
    });

    return NextResponse.json({ request: result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to decide vacation request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    // Lost a race: the request moved, or the approver's step was already decided, since the approver
    // read it (vacationDecisionWriteError). Nothing was written; the screen should reload, not retry blind.
    if (error instanceof ApiError && error.status === 409) {
      return NextResponse.json({ error: error.code, message, success: false }, { status: 409 });
    }
    if (isVacationSchemaMissing(error)) {
      return NextResponse.json({ error: "vacation_schema_missing", message, success: false }, { status: 409 });
    }
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message, success: false },
        { headers: { "Retry-After": String(error.retryAfterSeconds) }, status: 429 },
      );
    }
    return NextResponse.json({ error: "vacation_decision_failed", message, success: false }, { status: 400 });
  }
}
