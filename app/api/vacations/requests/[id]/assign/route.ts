import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  assignVacationManagementApprover,
  isVacationSchemaMissing,
  vacationErrorMessage,
} from "@/lib/vacation/service";
import { assertVacationRouteRateLimit } from "@/lib/vacation/route-guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HR assigns the first management approver to a Needs-HR-Assignment vacation request, resuming
// the sequential workflow. Authorization is enforced in the service (HR / Super Admin only).
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
      scope: "vacation:assign",
      windowMs: 60_000,
    });

    const body = await request.json();
    const approverHrId = typeof body.approverHrId === "string" ? body.approverHrId.trim() : "";
    if (!approverHrId) {
      return NextResponse.json(
        { error: "invalid_approver", message: "A management approver is required.", success: false },
        { status: 400 },
      );
    }

    const result = await assignVacationManagementApprover(access, { approverHrId, requestId: id });
    return NextResponse.json({ request: result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to assign approver.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
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
    return NextResponse.json({ error: "vacation_assign_failed", message, success: false }, { status: 400 });
  }
}
