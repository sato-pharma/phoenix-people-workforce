import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  askDirectOrderWithoutReceipt,
  decideDirectOrderHandEntry,
  decideDirectOrderWithoutReceipt,
  recordDirectOrderDelivery,
  recordDirectOrderReceipt,
  recordDirectOrderWarehouseExit,
  releaseDirectOrderReceipt,
} from "@/lib/direct-orders/receipt-books";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enter the delivery receipt that proves this order (owner, 26 Nov 2026: "Build the check"). Every
 * receipt has two originals and a copy (owner, 27 Nov 2026): with no action, Original 1 — the
 * manager's custody page, which claims the receipt; `{ action: "delivery", serial, code, photoDataUrl }`
 * adds Original 2 — the page the customer signed and stamped; `{ action: "warehouse_exit", exitDate }`
 * is Finance recording the day the goods left the warehouse, from which both due dates count.
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
 *
 * `{ action: "decide_hand_entry", entryId, decision: "approve" | "reject", note }` — an original typed by hand
 * (its QR not read in the photo) is reviewed: Finance reviews a manager's, the Super Admin reviews Finance's
 * (owner, 28 Nov 2026). Never by the person who typed it.
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
      exitDate?: unknown;
      entryId?: unknown;
    };
    if (body.action === "ask_without_receipt") {
      const asked = await askDirectOrderWithoutReceipt(access, { requestId: id, reason: body.reason ?? null });
      return NextResponse.json({ success: true, message: asked.message });
    }
    if (body.action === "decide_without_receipt") {
      const decided = await decideDirectOrderWithoutReceipt(access, { requestId: id, decision: body.decision ?? null, note: body.note ?? null });
      return NextResponse.json({ success: true, message: decided.message });
    }
    if (body.action === "decide_hand_entry") {
      const decided = await decideDirectOrderHandEntry(access, { requestId: id, entryId: body.entryId ?? null, decision: body.decision ?? null, note: body.note ?? null });
      return NextResponse.json({ success: true, message: decided.message });
    }
    if (body.action === "warehouse_exit") {
      const recorded = await recordDirectOrderWarehouseExit(access, { requestId: id, exitDate: body.exitDate ?? null });
      return NextResponse.json({ success: true, message: recorded.message });
    }
    if (body.action === "delivery") {
      const delivered = await recordDirectOrderDelivery(access, {
        requestId: id,
        serial: body.serial ?? null,
        code: body.code ?? null,
        photoDataUrl: body.photoDataUrl ?? null,
      });
      return NextResponse.json({ success: true, message: delivered.message, serial: delivered.serialLabel, pendingReview: delivered.pendingReview });
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
    return NextResponse.json({ success: true, message: result.message, serial: result.serialLabel, pendingReview: result.pendingReview });
  } catch (error) {
    const apiError = toApiError(error, "Could not save the receipt.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
