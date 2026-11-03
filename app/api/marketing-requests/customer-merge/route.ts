import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listMarketingCustomerMergeOptions, mergeMarketingCustomers } from "@/lib/marketing-requests/customer-merge";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The customers a merge can name, with what a person needs to judge a pair. Super Admin only, in the service. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json({ customers: await listMarketingCustomerMergeOptions(access) });
  } catch (error) {
    const apiError = toApiError(error, "Could not load the customer list.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message }, { status });
  }
}

/**
 * Fold one customer into another. Identity is the caller's judgement and nothing here guesses it, so a
 * written reason is required. Zero authorization logic here: the service holds it.
 */
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      carryEvidence?: unknown;
      reason?: unknown;
      retiredId?: unknown;
      survivorId?: unknown;
    };
    const result = await mergeMarketingCustomers(access, {
      carryEvidence: body.carryEvidence === true,
      reason: String(body.reason ?? ""),
      retiredId: String(body.retiredId ?? ""),
      survivorId: String(body.survivorId ?? ""),
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not merge the customers.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
