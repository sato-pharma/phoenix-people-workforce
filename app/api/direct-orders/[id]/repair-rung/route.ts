import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { repairDirectOrderApprovalRung } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-address a stuck approval rung to a person the employee directory actually knows.
 *
 * The order does NOT move: same status, same number of approvals still owed, same seats. Only the
 * HR_ID the rung is addressed to changes — see `repairDirectOrderApprovalRung`, which holds every
 * rule, including the one that matters most: it REFUSES a rung whose approver resolves perfectly
 * well, so this cannot be used to route around an approver.
 *
 * This route decides nothing. Super Admin only, the registry transition, the broken-rung test and
 * the self-approval test all live in the service.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      stepId?: string;
      newApproverHrId?: string;
      reason?: string;
    };
    const result = await repairDirectOrderApprovalRung(access, {
      requestId: id,
      stepId: String(body.stepId ?? "").trim(),
      newApproverHrId: String(body.newApproverHrId ?? "").trim(),
      reason: String(body.reason ?? ""),
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const apiError = toApiError(error, "Could not repair this approval rung.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
