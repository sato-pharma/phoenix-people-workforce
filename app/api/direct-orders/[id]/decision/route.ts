import { after, NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { decideDirectOrder, dispatchDirectOrderApprovedEmail } from "@/lib/direct-orders/service";
import type { DirectOrderDecision } from "@/lib/direct-orders/types";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Approvals Hub "Direct Orders Approvals" page is the ONLY approval gate.
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { decision?: string; comment?: string | null };
    const decision = String(body.decision ?? "").trim() as DirectOrderDecision;
    if (!["approve", "reject", "return"].includes(decision)) {
      return NextResponse.json(
        { error: "invalid_request", message: "decision must be approve, reject, or return.", success: false },
        { status: 400 },
      );
    }
    const result = await decideDirectOrder(access, { requestId: id, decision, comment: body.comment ?? null });
    // On final approval of a normal order, email the polished details table AFTER the
    // response is sent (To Ahmed, CC CEO + system admin) — never blocks the approver.
    if (result.status === "approved" && !result.reversalOfRequestId) {
      after(() => dispatchDirectOrderApprovedEmail(result.id));
    }
    return NextResponse.json({ result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not record the decision.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
