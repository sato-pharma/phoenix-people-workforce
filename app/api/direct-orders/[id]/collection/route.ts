import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { recordDirectOrderCollection } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record the money collected against an approved direct order — or clear it with paidAmount: null.
 *
 * Separate from the sales-month route on purpose: approval, booking a month, and collecting the
 * cash are three different events, and this one must never move which month the sales landed in.
 * `remainingAmount` is derived in the service from the order value and is deliberately NOT
 * accepted from the client. Authorization lives in the service (Finance / Super Admin only) —
 * this route never decides who may call it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      paidAmount?: number | null;
      paymentDate?: string | null;
    };
    const updated = await recordDirectOrderCollection(access, {
      requestId: id,
      paidAmount: body.paidAmount ?? null,
      paymentDate: body.paymentDate ?? null,
    });
    return NextResponse.json({
      success: true,
      paidAmount: updated.paidAmount,
      paymentDate: updated.paymentDate,
      remainingAmount: updated.remainingAmount,
    });
  } catch (error) {
    const apiError = toApiError(error, "Could not record the collection.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
