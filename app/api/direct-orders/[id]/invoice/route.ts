import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { attachDirectOrderInvoice } from "@/lib/direct-orders/order-invoice";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Attach (or replace) the distributor invoice on an order already sent (owner, 2026-09-14).
 *
 * Every rule lives in the service — the requester only, and only while the order is held or still
 * with the SFE Manager. This route decides nothing.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { invoiceDataUrl?: unknown };
    const result = await attachDirectOrderInvoice(access, { requestId: id, invoiceDataUrl: body.invoiceDataUrl ?? null });
    return NextResponse.json({ success: true, message: result.message });
  } catch (error) {
    const apiError = toApiError(error, "Could not attach the invoice.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
