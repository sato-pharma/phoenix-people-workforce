import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  addPharmacyToMarketingCustomer,
  findPharmacyForCustomerByCode,
  listCustomerEditDistributors,
  removePharmacyFromMarketingCustomer,
  type AddPharmacyToCustomerInput,
} from "@/lib/marketing-requests/customer-edit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown, fallback: string) {
  const apiError = toApiError(error, fallback);
  const status = isForbiddenError(error) ? 403 : apiError.status;
  return NextResponse.json(
    { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
    { status },
  );
}

/**
 * With `distributorId` and `code`: the pharmacy that code belongs to — the one on file, else the
 * distributor's own record of it. Without them: the distributors to choose from. Super Admin only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const url = new URL(request.url);
    const distributorId = (url.searchParams.get("distributorId") ?? "").trim();
    const code = (url.searchParams.get("code") ?? "").trim();
    if (!distributorId || !code) {
      return NextResponse.json({ distributors: await listCustomerEditDistributors(access) });
    }
    return NextResponse.json(await findPharmacyForCustomerByCode(access, { customerId: id, distributorId, pharmacyCode: code }));
  } catch (error) {
    return failure(error, "Could not look up that code.");
  }
}

/** Add a pharmacy to this customer — one on file by id, or a new one with its code and map pin. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const input: AddPharmacyToCustomerInput = body.pharmacyId
      ? { pharmacyId: String(body.pharmacyId) }
      : {
        address: body.address == null ? null : String(body.address),
        area: body.area == null ? null : String(body.area),
        displayName: String(body.displayName ?? ""),
        distributorId: String(body.distributorId ?? ""),
        governorate: body.governorate == null ? null : String(body.governorate),
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
        pharmacyCode: String(body.pharmacyCode ?? ""),
      };
    return NextResponse.json({ ...(await addPharmacyToMarketingCustomer(access, id, input)), success: true });
  } catch (error) {
    return failure(error, "Could not add the pharmacy.");
  }
}

/** Take a pharmacy off this customer. Its links are switched off, never deleted. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { pharmacyId?: unknown; reason?: unknown };
    return NextResponse.json({
      ...(await removePharmacyFromMarketingCustomer(access, id, {
        pharmacyId: String(body.pharmacyId ?? ""),
        reason: String(body.reason ?? ""),
      })),
      success: true,
    });
  } catch (error) {
    return failure(error, "Could not remove the pharmacy.");
  }
}
