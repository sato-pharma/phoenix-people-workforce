import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listPharmacyGeoVariances, resolvePharmacyGeoVariance } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const result = await listPharmacyGeoVariances(access);
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not load variances.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { pharmacyId?: string; action?: string };
    await resolvePharmacyGeoVariance(access, {
      pharmacyId: String(body.pharmacyId ?? ""),
      action: body.action === "apply" ? "apply" : "keep",
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not resolve the variance.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false }, { status });
  }
}
