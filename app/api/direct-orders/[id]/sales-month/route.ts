import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { setDirectOrderSalesMonth } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Book a direct order into a sales month (or clear it with salesMonth: null).
 *
 * Money-critical: changing the month moves the order's value between Source-of-Sales periods,
 * so the service rebuilds BOTH the old and the new month. Authorization lives in the service
 * (Finance / Super Admin only) — this route never decides who may call it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { salesMonth?: string | null };
    const requestedMonth = body.salesMonth ?? null;
    const updated = await setDirectOrderSalesMonth(access, {
      requestId: id,
      salesMonth: requestedMonth,
    });

    // A booking aimed at a PUBLISHED closing is carried forward to the first open month rather
    // than refused (owner, 2026-09-07). The response has to say so: the caller asked for one month
    // and got another, and a screen that reports back the month it SENT would leave Finance
    // believing the closing had accepted it.
    const shifted = Boolean(
      requestedMonth && updated.salesMonth && updated.salesMonth !== requestedMonth,
    );
    return NextResponse.json({
      success: true,
      salesMonth: updated.salesMonth,
      ...(shifted ? { requestedMonth, shifted: true } : {}),
    });
  } catch (error) {
    const apiError = toApiError(error, "Could not set the sales month.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
