import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { createDirectOrderPharmacy, listMyDirectOrderPharmacies } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// List the caller's previously-coded direct-order pharmacies (for reuse on a new request).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const pharmacies = await listMyDirectOrderPharmacies(access);
    return NextResponse.json({ pharmacies, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load pharmacies.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}

// Code a new direct-order pharmacy (Phoenix auto-generates its stable code).
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      pharmacyName?: string;
      brickId?: string | null;
      areaCode?: string | null;
      regionCode?: string | null;
      doctorName?: string | null;
      pharmacyAddress?: string | null;
      distributorCodes?: Array<{ distributorCode?: string; customerCode?: string }>;
      /**
       * The submitter was shown the pharmacy that already holds a code they typed, and answered
       * that theirs is a different one. Without it a collision is refused BY NAME (naming the
       * incumbent) instead of half-creating a codeless duplicate the way it used to. The service
       * re-checks the conflict itself, so this flag can only ever add the recorded dispute — it
       * can never skip the check.
       */
      acknowledgedCodeConflict?: boolean;
    };
    const pharmacy = await createDirectOrderPharmacy(access, {
      acknowledgedCodeConflict: body.acknowledgedCodeConflict === true,
      pharmacyName: String(body.pharmacyName ?? "").trim(),
      brickId: body.brickId ?? null,
      areaCode: body.areaCode ?? null,
      regionCode: body.regionCode ?? null,
      doctorName: body.doctorName ?? null,
      pharmacyAddress: body.pharmacyAddress ?? null,
      distributorCodes: (body.distributorCodes ?? []).map((pair) => ({
        distributorCode: String(pair.distributorCode ?? "").trim(),
        customerCode: String(pair.customerCode ?? "").trim(),
      })),
    });
    return NextResponse.json({ pharmacy, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not create the pharmacy.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
