import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  askDirectOrderWithoutReceipt,
  decideDirectOrderWithoutReceipt,
  recordDirectOrderReceipt,
  releaseDirectOrderReceipt,
} from "@/lib/direct-orders/receipt-books";
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
 *
 * `{ action: "ask_without_receipt", reason }` — Finance asks the CEO to let the order stand without a
 * receipt; `{ action: "decide_without_receipt", decision: "approve" | "refuse", note }` — the CEO alone
 * decides (owner, 27 Nov 2026: making an order without a receipt is Dr Anwar's authority only).
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      reason?: unknown;
      decision?: unknown;
      note?: unknown;
      serial?: unknown;
      code?: unknown;
      photoDataUrl?: unknown;
    };
    if (body.action === "ask_without_receipt") {
      const asked = await askDirectOrderWithoutReceipt(access, { requestId: id, reason: body.reason ?? null });
      return NextResponse.json({ success: true, message: asked.message });
    }
    if (body.action === "decide_without_receipt") {
      const decided = await decideDirectOrderWithoutReceipt(access, { requestId: id, decision: body.decision ?? null, note: body.note ?? null });
      return NextResponse.json({ success: true, message: decided.message });
    }
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
