import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  acknowledgeDirectOrderPharmacy,
  listDirectOrderPharmacyRegistry,
  registerDirectOrderPharmacy,
  replaceDirectOrderPharmacyCodes,
  updateDirectOrderPharmacyDetails,
} from "@/lib/direct-orders/service";
import { describeUnexpectedError, toApiError } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The pharmacy registry: set a pharmacy up BEFORE any order needs it, so the order that arrives
// later is recognised and takes the ordinary approval chain.
//
// Every gate here lives in the SERVICE, not in this file. The route only shapes the request —
// hiding a button or omitting an action would be UX, and this endpoint is reachable directly.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const result = await listDirectOrderPharmacyRegistry(access);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the pharmacy registry.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    if (status >= 500) {
      logError("pharmacy-registry GET failed", {
        labels: { event: "pharmacy_registry_get_failed" },
        context: { detail: describeUnexpectedError(error) },
        error,
      });
    }
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}

type CodePair = { distributorCode?: string; customerCode?: string };

const pairs = (input: CodePair[] | undefined) =>
  (input ?? []).map((pair) => ({
    distributorCode: String(pair.distributorCode ?? "").trim(),
    customerCode: String(pair.customerCode ?? "").trim(),
  }));

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      pharmacyId?: string;
      pharmacyName?: string | null;
      brickId?: string | null;
      areaCode?: string | null;
      regionCode?: string | null;
      doctorName?: string | null;
      pharmacyAddress?: string | null;
      distributorCodes?: CodePair[];
      /** See the same field on POST /api/direct-orders/pharmacies — normalized by the service. */
      venueType?: string | null;
    };

    if (body.action === "register") {
      const pharmacy = await registerDirectOrderPharmacy(access, {
        pharmacyName: String(body.pharmacyName ?? "").trim(),
        brickId: body.brickId ?? null,
        areaCode: body.areaCode ?? null,
        regionCode: body.regionCode ?? null,
        doctorName: body.doctorName ?? null,
        pharmacyAddress: body.pharmacyAddress ?? null,
        venueType: body.venueType ?? null,
        distributorCodes: pairs(body.distributorCodes),
      });
      return NextResponse.json({ pharmacy, success: true });
    }

    if (body.action === "updateDetails") {
      // Only the keys actually present are forwarded, so an unedited field is never blanked —
      // `undefined` means "leave it", `null` means "clear it", and the two must stay distinct all
      // the way to the service.
      await updateDirectOrderPharmacyDetails(access, {
        pharmacyId: String(body.pharmacyId ?? ""),
        ...("pharmacyName" in body ? { pharmacyName: body.pharmacyName } : {}),
        ...("brickId" in body ? { brickId: body.brickId } : {}),
        ...("areaCode" in body ? { areaCode: body.areaCode } : {}),
        ...("regionCode" in body ? { regionCode: body.regionCode } : {}),
        ...("doctorName" in body ? { doctorName: body.doctorName } : {}),
        ...("pharmacyAddress" in body ? { pharmacyAddress: body.pharmacyAddress } : {}),
      });
      return NextResponse.json({ success: true });
    }

    if (body.action === "replaceCodes") {
      await replaceDirectOrderPharmacyCodes(access, {
        pharmacyId: String(body.pharmacyId ?? ""),
        distributorCodes: pairs(body.distributorCodes),
      });
      return NextResponse.json({ success: true });
    }

    if (body.action === "confirm") {
      // Clearing a pharmacy that is holding an order is the System Admin rung itself, so this
      // deliberately routes to the SAME Super-Admin-only function the approval path uses rather
      // than to a registry-level permission. SFE reaching this gets a 403, by design.
      await acknowledgeDirectOrderPharmacy(access, { pharmacyId: String(body.pharmacyId ?? "") });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "bad_request", message: "Unknown action.", success: false }, { status: 400 });
  } catch (error) {
    const apiError = toApiError(error, "Could not update the pharmacy registry.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    if (status >= 500) {
      // A 500 here is almost always a raw PostgREST error object (not an Error instance) that
      // toApiError cannot unwrap — log the full detail so Railway shows the real DB message.
      logError("pharmacy-registry POST failed", {
        labels: { event: "pharmacy_registry_post_failed" },
        context: { action: (typeof error === "object" && error ? String((error as Record<string, unknown>).action ?? "") : ""), detail: describeUnexpectedError(error) },
        error,
      });
    }
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
