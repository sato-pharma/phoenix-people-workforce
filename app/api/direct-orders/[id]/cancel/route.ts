import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { cancelHeldDirectOrder } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancel a held direct order (audit finding F3) — the requester withdrawing a duplicate.
 *
 * The whole authorization decision lives in `cancelHeldDirectOrder`, not here: requester-or-Super-
 * Admin, held-only, reason required, plus the registry gate. A route that re-implemented any part
 * of that would be a second rule to keep in step with the first.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const result = await cancelHeldDirectOrder(access, {
      requestId: id,
      reason: String(body.reason ?? "").trim(),
    });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not cancel the held direct order.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
