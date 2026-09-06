import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { reopenRejectedMarketingRequest } from "@/lib/marketing-requests/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Reopen a refused marketing request onto the rung that refused it.
 *
 * Super Admin only, enforced in the domain service — the Case File's button is an affordance and
 * this route re-runs the gate before anything is written. The reason is required here as well as
 * in the service and again in the RPC: it is the only record of why a recorded refusal was undone.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { reason?: string | null };
    const result = await reopenRejectedMarketingRequest(access, { reason: body?.reason ?? null, requestId: id });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Marketing request reopen failed.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
