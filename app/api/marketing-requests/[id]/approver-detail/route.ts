import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getMarketingRequestApproverDetail } from "@/lib/marketing-requests/approver-detail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read-only full detail for the approver holding this request.
 *
 * Authorization lives in the service (assertMarketingStepAssignedToActor via
 * getMarketingRequestDecisionSummary): only the approver who currently holds the request can read
 * it. That tightness is required, not incidental — the payload carries the customer's address,
 * contact mobile and full target-pharmacy list.
 */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getMarketingRequestApproverDetail(id, access));
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "Forbidden." }, { status: 403 });
    }
    const apiError = toApiError(error, "Marketing request detail failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
