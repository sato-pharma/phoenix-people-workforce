import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { reverseDirectOrder } from "@/lib/direct-orders/service";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    const result = await reverseDirectOrder(access, { requestId: id, reason: String(body.reason ?? "").trim() });
    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not reverse the direct order.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
