import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { submitDirectOrder } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      productCode?: string;
      pharmacyId?: string;
      qty?: number | string;
      dealType?: string;
      bonus?: number | string;
      discountPct?: number | string;
      bonusOverrideReason?: string | null;
      collectionDate?: string | null;
      /**
       * EXTRA lines for a family basket. Passed through UNVALIDATED on purpose: every rule about
       * what may share a request — same family, an allow-listed family, no product twice, the
       * requester's own line — lives in resolveDirectOrderBasket, and a copy here would be a second
       * place for them to drift. This route decides nothing, exactly like the fields above it.
       */
      items?: Array<{
        productCode?: string;
        qty?: number | string;
        dealType?: string;
        bonus?: number | string;
        discountPct?: number | string | null;
      }>;
    };
    const result = await submitDirectOrder(access, {
      productCode: String(body.productCode ?? "").trim(),
      pharmacyId: String(body.pharmacyId ?? "").trim(),
      qty: Number(body.qty ?? 0),
      dealType: body.dealType === "discount" ? "discount" : "bonus",
      bonus: Number(body.bonus ?? 0),
      discountPct: body.discountPct == null ? null : Number(body.discountPct),
      bonusOverrideReason: body.bonusOverrideReason ?? null,
      collectionDate: body.collectionDate ?? null,
      items: (body.items ?? []).map((item) => ({
        productCode: String(item.productCode ?? "").trim(),
        qty: Number(item.qty ?? 0),
        dealType: item.dealType === "discount" ? "discount" : "bonus",
        bonus: Number(item.bonus ?? 0),
        discountPct: item.discountPct == null ? null : Number(item.discountPct),
      })),
    });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not submit the direct order.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
