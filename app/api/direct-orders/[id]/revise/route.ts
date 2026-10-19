import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { reviseDirectOrder } from "@/lib/direct-orders/service";
import type { DirectOrderDealType } from "@/lib/direct-orders/types";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Correct a RETURNED direct order and put it back in front of the same approver.
 *
 * Same request, same id, same approval chain — see `reviseDirectOrder`. Authorization (requester
 * role, ownership of the order, and the returned-status precondition) lives entirely in the
 * service; this route never decides who may call it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      qty?: number;
      dealType?: DirectOrderDealType;
      bonus?: number;
      discountPct?: number | null;
      bonusOverrideReason?: string | null;
      collectionDate?: string | null;
      correctionNote?: string | null;
      /** Every line after the first, corrected — see `resolveCorrectionExtraLines`. */
      items?: Array<{
        productCode?: string;
        qty?: number | string;
        dealType?: string;
        bonus?: number | string;
        discountPct?: number | string | null;
      }>;
    };
    const updated = await reviseDirectOrder(access, {
      requestId: id,
      qty: Number(body.qty),
      dealType: body.dealType,
      bonus: body.bonus,
      discountPct: body.discountPct ?? null,
      bonusOverrideReason: body.bonusOverrideReason ?? null,
      collectionDate: body.collectionDate ?? null,
      correctionNote: body.correctionNote ?? null,
      // 🔴 ABSENT STAYS ABSENT — never `?? []`. An empty list says "no other lines", and the service
      // keeps every stored line only when nothing was sent; defaulting here is what dropped a returned
      // basket's second line (code review, 19 Oct 2026).
      items: Array.isArray(body.items)
        ? body.items.map((item) => ({
            productCode: String(item.productCode ?? "").trim(),
            qty: Number(item.qty ?? 0),
            dealType: item.dealType === "discount" ? "discount" : "bonus",
            bonus: Number(item.bonus ?? 0),
            discountPct: item.discountPct == null ? null : Number(item.discountPct),
          }))
        : undefined,
    });
    return NextResponse.json({ success: true, status: updated.status, id: updated.id });
  } catch (error) {
    const apiError = toApiError(error, "Could not resubmit this order.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
