import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { deleteDirectOrderCap, listDirectOrderCaps, upsertDirectOrderCap } from "@/lib/direct-orders/caps";
import { setDirectOrderProductPrices, setProductPublicPrice } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const result = await listDirectOrderCaps(access);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load caps.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      productCode?: string;
      bonusCapPct?: number | null;
      discountCapPct?: number | null;
      publicPrice?: number | null;
      pharmacyPrice?: number | null;
    };
    if (body.action === "delete") {
      await deleteDirectOrderCap(access, String(body.productCode ?? ""));
    } else if (body.action === "productPrices") {
      // One atomic write for the price grid's per-row Save — two sequential requests could
      // leave a row half-saved.
      await setDirectOrderProductPrices(access, {
        productCode: String(body.productCode ?? ""),
        publicPrice: body.publicPrice ?? null,
        pharmacyPrice: body.pharmacyPrice ?? null,
      });
    } else if (body.action === "publicPrice") {
      await setProductPublicPrice(access, { productCode: String(body.productCode ?? ""), publicPrice: body.publicPrice ?? null });
    } else {
      await upsertDirectOrderCap(access, {
        productCode: String(body.productCode ?? ""),
        bonusCapPct: body.bonusCapPct ?? null,
        discountCapPct: body.discountCapPct ?? null,
      });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not update caps.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false }, { status });
  }
}
