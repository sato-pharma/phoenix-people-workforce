import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { cancelMarketingRequest } from "@/lib/marketing-requests/cancel";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancel — call off a marketing request that entered the chain but is no longer wanted.
 *
 * Super Admin only, enforced in the domain module — the Case File's button is an affordance and
 * this route re-runs the gate before anything is written. The reason is required here as well as in
 * the service: it is the only durable record of why an in-flight request was abandoned.
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
    const result = await cancelMarketingRequest({ access, reason: body?.reason ?? "", requestId: id });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Marketing request cancel failed.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
