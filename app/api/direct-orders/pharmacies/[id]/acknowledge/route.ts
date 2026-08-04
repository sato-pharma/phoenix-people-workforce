import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { acknowledgeDirectOrderPharmacy } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirm that a hand-entered pharmacy's distributor codes are real.
 *
 * Super Admin only, enforced in the service. This is the release valve on "never block": the
 * order flows the whole time, and this records that somebody with authority checked the codes —
 * which is what stops a mistyped code mis-attributing retail sales indefinitely.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    await acknowledgeDirectOrderPharmacy(access, { pharmacyId: id });
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not acknowledge this pharmacy.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
