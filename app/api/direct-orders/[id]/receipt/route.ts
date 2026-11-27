import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { recordDirectOrderReceipt, releaseDirectOrderReceipt } from "@/lib/direct-orders/receipt-books";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enter the delivery receipt that proves this order (owner, 26 Nov 2026: "Build the check").
 *
 * Every rule lives in the service — the requester or Finance only, the code must match the serial,
 * the book must be issued to the requester, and the receipt is claimed once. This route decides nothing.
 *
 * `{ action: "release", reason }` takes a receipt off an order it was entered on by mistake — Finance
 * or the Administrator only, with a written reason (owner, 27 Nov 2026: "make an undo option").
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; reason?: unknown; serial?: unknown; code?: unknown; photoDataUrl?: unknown };
    if (body.action === "release") {
      const released = await releaseDirectOrderReceipt(access, { requestId: id, reason: body.reason ?? null });
      return NextResponse.json({ success: true, message: released.message });
    }
    const result = await recordDirectOrderReceipt(access, {
      requestId: id,
      serial: body.serial ?? null,
      code: body.code ?? null,
      photoDataUrl: body.photoDataUrl ?? null,
    });
    return NextResponse.json({ success: true, message: result.message, serial: result.serialLabel });
  } catch (error) {
    const apiError = toApiError(error, "Could not save the receipt.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
