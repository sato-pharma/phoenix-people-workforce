import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import {
  listDirectOrderPharmacyValidations,
  requestDirectOrderPharmacyValidation,
  type DirectOrderValidationStatus,
} from "@/lib/direct-orders/pharmacy-validation";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = the Super Admin validation desk (spec A2). Service enforces Super-Admin-only.
// POST = a rep submits evidence for the pharmacy behind their held order.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const status = new URL(request.url).searchParams.get("status");
    const rows = await listDirectOrderPharmacyValidations(
      access,
      status ? { status: status as DirectOrderValidationStatus } : undefined,
    );
    return NextResponse.json({ rows, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load pharmacy validations.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await requestDirectOrderPharmacyValidation(access, {
      pharmacyId: String(body.pharmacyId ?? ""),
      requestId: body.requestId ? String(body.requestId) : null,
      claimedPharmacyName: String(body.claimedPharmacyName ?? ""),
      claimedAddress: body.claimedAddress ? String(body.claimedAddress) : null,
      claimedDoctorName: body.claimedDoctorName ? String(body.claimedDoctorName) : null,
      claimedReason: String(body.claimedReason ?? ""),
      photoDataUrl: String(body.photoDataUrl ?? ""),
      capturedLatitude: body.capturedLatitude == null ? null : Number(body.capturedLatitude),
      capturedLongitude: body.capturedLongitude == null ? null : Number(body.capturedLongitude),
      capturedAccuracyMeters: body.capturedAccuracyMeters == null ? null : Number(body.capturedAccuracyMeters),
      capturedAt: body.capturedAt ? String(body.capturedAt) : null,
      capturedAddress: body.capturedAddress ? String(body.capturedAddress) : null,
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not submit the pharmacy validation.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
