import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { resubmitVacationRequest, vacationErrorMessage } from "@/lib/vacation/service";
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
      limit: 20,
      request,
      scope: "vacation:resubmit",
      windowMs: 60_000,
    });

    const result = await resubmitVacationRequest(access, { requestId: id });
    return NextResponse.json({ request: result, success: true });
  } catch (error) {
    const message = vacationErrorMessage(error) || "Unable to resubmit vacation request.";
    if (isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:")) {
      return NextResponse.json({ error: "forbidden", message, success: false }, { status: 403 });
    }
    return NextResponse.json({ error: "resubmit_failed", message, success: false }, { status: 400 });
  }
}
