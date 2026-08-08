import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  keepDirectOrderHeld,
  linkDirectOrderPharmacyCode,
  releaseHeldDirectOrdersForPharmacy,
} from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The System Admin's three rulings on a held pharmacy (owner rule, 2026-08-08).
 *
 *   release    — let its held orders into the approval chain on the admin's own judgement, when no
 *                distributor code can prove it (the live case is a placeholder like PS/000000).
 *   keep       — record that somebody looked and the orders deliberately stay held. Without this,
 *                "nobody has looked" and "looked and said no" are the same empty state.
 *   link_code  — the code was typed into the pharmacy NAME field. Link it properly, optionally
 *                rename, and let the shared hold rule decide whether that now releases the orders.
 *
 * Keyed by PHARMACY, not request: a ruling about a pharmacy has to cover its sibling orders and the
 * next one submitted, or every reorder re-freezes behind the same unanswered question.
 *
 * Zero authorization logic here — the service asserts Held Desk access, exactly as the cancel route
 * delegates to cancelHeldDirectOrder.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      decision?: string;
      pharmacyId?: string;
      reason?: string;
      distributorCode?: string;
      customerCode?: string;
      renameToCustomerName?: boolean;
    };

    const pharmacyId = String(body.pharmacyId ?? "").trim();
    if (!pharmacyId) {
      return NextResponse.json(
        { error: "validation_error", message: "A pharmacy is required.", success: false },
        { status: 400 },
      );
    }

    if (body.decision === "release") {
      const result = await releaseHeldDirectOrdersForPharmacy(access, {
        pharmacyId,
        ground: "admin_released",
        reason: body.reason ?? null,
      });
      return NextResponse.json({ ...result, success: true });
    }
    if (body.decision === "keep") {
      const result = await keepDirectOrderHeld(access, { pharmacyId, reason: String(body.reason ?? "") });
      return NextResponse.json({ ...result, success: true });
    }
    if (body.decision === "link_code") {
      const result = await linkDirectOrderPharmacyCode(access, {
        pharmacyId,
        distributorCode: String(body.distributorCode ?? ""),
        customerCode: String(body.customerCode ?? ""),
        renameToCustomerName: body.renameToCustomerName === true,
      });
      return NextResponse.json({ ...result, success: true });
    }

    return NextResponse.json(
      { error: "validation_error", message: "Unknown decision.", success: false },
      { status: 400 },
    );
  } catch (error) {
    const apiError = toApiError(error, "Could not record the held decision.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
