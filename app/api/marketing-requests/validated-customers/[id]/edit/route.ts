import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { updateMarketingCustomerDetails } from "@/lib/marketing-requests/customer-edit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The Super Admin changes a customer's name, speciality and phone. Authorization is in the service. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      displayName?: unknown;
      mobileNumber?: unknown;
      speciality?: unknown;
    };
    const result = await updateMarketingCustomerDetails(access, id, {
      displayName: String(body.displayName ?? ""),
      mobileNumber: body.mobileNumber == null ? null : String(body.mobileNumber),
      speciality: body.speciality == null ? null : String(body.speciality),
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not save the customer.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
