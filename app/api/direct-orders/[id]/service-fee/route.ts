import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { settleServiceFeeAsAdministrator } from "@/lib/direct-orders/service-fee-settlement-service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The Administrator records a service fee owed to the pharmacy's doctor against this order, in one
 * step: a marketing request is raised under the order's requester, its whole chain is decided by
 * the Administrator, and the amount is settled against the order's debt. No cash moves.
 *
 * The requester is read from the order, never from the body, and authority lives in the service —
 * this route never decides who may call it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as {
      amount?: unknown;
      beneficiaryName?: unknown;
      note?: unknown;
      requestTypeCode?: unknown;
    };
    const result = await settleServiceFeeAsAdministrator(access, {
      amount: Number(body.amount),
      beneficiaryName: typeof body.beneficiaryName === "string" ? body.beneficiaryName : "",
      directOrderId: id,
      note: typeof body.note === "string" ? body.note : null,
      requestTypeCode: typeof body.requestTypeCode === "string" ? body.requestTypeCode : "",
    });
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const apiError = toApiError(error, "Could not record the service fee.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
