import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getValidatedMarketingCustomerDetailForApprover } from "@/lib/marketing-requests/validated-customer-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The full validation dossier for the customer a marketing request stands on — for the approver
 * holding that request (owner ask, 2026-09-22: the "already validated" badge jumps here).
 *
 * Authorization lives entirely in the service. getValidatedMarketingCustomerDetailForApprover runs
 * getMarketingRequestDecisionSummary first, which throws unless the caller currently holds this
 * request's pending approval step — the SAME gate as the approver window this dossier is reached
 * from. The route is keyed by REQUEST id, never customer id, precisely so an approver can only open
 * the dossier for a request the system already put in their hands, and cannot enumerate the
 * customer register.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getValidatedMarketingCustomerDetailForApprover(access, id));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Could not load the customer dossier.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
