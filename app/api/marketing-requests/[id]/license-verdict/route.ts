import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  parseLicenseVerdict,
  recordMarketingPharmacyLicenseVerdict,
} from "@/lib/marketing-requests/pharmacy-license-verdict";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Record the approver's "does the licence name match the shop sign?" answer for one pharmacy on
 * this request.
 *
 * Scoped under the REQUEST rather than under the pharmacy on purpose: the service authorizes by
 * the request's current approval step, so routing it this way keeps the URL and the gate telling
 * the same story. A pharmacy-scoped endpoint would have had to invent its own permission rule.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json()) as { matchesSign?: unknown; pharmacyId?: unknown };

    const result = await recordMarketingPharmacyLicenseVerdict(access, {
      // Anything that is not an explicit true/false clears the answer — one rule, shared with the
      // service so the endpoint and the writer can never disagree about what counts as an answer.
      matchesSign: parseLicenseVerdict(body.matchesSign),
      pharmacyId: String(body.pharmacyId ?? ""),
      requestId: id,
    });

    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Recording the licence check failed.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
