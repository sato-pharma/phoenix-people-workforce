import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { checkDirectOrderPharmacyBeforeCreate } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Did you mean this pharmacy?" — asked BEFORE a rep registers one by hand (owner, 2026-08-13).
//
// POST rather than GET only because the question carries a list of (distributor, customer code)
// pairs; it writes nothing. The same-origin assertion is kept anyway: it costs one header check and
// this endpoint reports which pharmacy owns a given distributor code, which is not something a
// third-party page should be able to enumerate from a logged-in browser.
//
// The answer is advisory in both directions. Nothing here decides whether the pharmacy may be
// created — createDirectOrderPharmacy re-checks the conflict server-side and refuses an
// unacknowledged one by name, so skipping this call cannot get a duplicate past the gate.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      pharmacyName?: string;
      areaCode?: string | null;
      regionCode?: string | null;
      distributorCodes?: Array<{ distributorCode?: string; customerCode?: string }>;
    };
    const preflight = await checkDirectOrderPharmacyBeforeCreate(access, {
      pharmacyName: String(body.pharmacyName ?? ""),
      areaCode: body.areaCode ?? null,
      regionCode: body.regionCode ?? null,
      distributorCodes: (body.distributorCodes ?? []).map((pair) => ({
        distributorCode: String(pair.distributorCode ?? ""),
        customerCode: String(pair.customerCode ?? ""),
      })),
    });
    return NextResponse.json({ ...preflight, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not check the pharmacy.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
