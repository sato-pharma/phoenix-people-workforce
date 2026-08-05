import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { rejectDirectOrderPharmacy } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record that a pharmacy was examined and found NOT to be real.
 *
 * The counterpart to `acknowledge`, and the strongest statement the module can make about a
 * pharmacy. Super Admin only, reason mandatory, enforced in the service.
 *
 * Deliberately its own endpoint rather than a decision on the validation desk: rejecting a
 * VALIDATION means "this evidence does not convince me" and leaves the rep free to try again;
 * this means "this pharmacy does not exist" and closes every order standing on it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const result = await rejectDirectOrderPharmacy(access, {
      pharmacyId: id,
      reason: String(body.reason ?? "").trim(),
    });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not reject this pharmacy.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
