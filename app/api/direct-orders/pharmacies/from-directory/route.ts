import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { ensureDirectOrderPharmacyFromDirectory } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Materialize (or reuse) a pharmacy from a combo-box selection (spec B1/B3).
// The body carries only POINTERS — a Phoenix code, or a (distributor, customer) pair —
// and every stored field comes from the trusted catalogue row server-side.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      phoenixPharmacyCode?: string | null;
      distributorCode?: string | null;
      customerCode?: string | null;
    };
    const pharmacy = await ensureDirectOrderPharmacyFromDirectory(access, {
      phoenixPharmacyCode: body.phoenixPharmacyCode ?? null,
      distributorCode: body.distributorCode ?? null,
      customerCode: body.customerCode ?? null,
    });
    return NextResponse.json({ pharmacy, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not resolve the selected pharmacy.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
