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
