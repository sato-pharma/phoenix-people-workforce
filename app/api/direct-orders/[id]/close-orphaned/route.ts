import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { closeOrphanedDirectOrder } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Close one returned direct order whose requester has left the company.
 *
 * A return is a question addressed to the ONE person who raised the order, and nothing expires a
 * `returned` order — so once that person resigns it can never be answered and nothing chases it.
 * The Needs You board has always found these; until now there was no way to clear one.
 *
 * This route decides nothing and chooses nothing. Super Admin only, the registry transition, the
 * requested status check, and the guard that REFUSES while the requester can still log in all live
 * in `closeOrphanedDirectOrder` — that last one is what separates this from a delete button.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const result = await closeOrphanedDirectOrder(access, {
      requestId: id,
      reason: String(body.reason ?? ""),
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const apiError = toApiError(error, "Could not close this order.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
