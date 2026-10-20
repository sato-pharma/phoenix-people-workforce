import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { transferValidatedCustomerToDirectOrders } from "@/lib/marketing-requests/validated-customer-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hand this customer to the Direct Order validation desk.
//
// The body carries an optional note and the admin's answer to "pharmacy or nursery" (required, and
// refused when absent): every other field written on the other side is read
// server-side from the trusted marketing record, the same discipline
// `ensureDirectOrderPharmacyFromDirectory` follows. A caller cannot dictate the name, the
// geography, or the codes by editing a payload.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      notes?: string | null;
      venueType?: string | null;
    };

    const result = await transferValidatedCustomerToDirectOrders(access, {
      customerId: id,
      notes: body.notes ?? null,
      venueType: body.venueType ?? null,
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not transfer that customer to Direct Orders.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
