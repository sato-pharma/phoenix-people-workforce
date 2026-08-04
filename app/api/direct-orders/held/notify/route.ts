import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { sendHeldDirectOrderNotices } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The bulk held-notice button (spec C3): one email per selected request — To the requester BY
// NAME, CC the SFE Manager, the requester's direct manager, and the CEO.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { requestIds?: string[] };
    const result = await sendHeldDirectOrderNotices(access, {
      requestIds: Array.isArray(body.requestIds) ? body.requestIds.map(String) : [],
    });
    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not send the held notices.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
