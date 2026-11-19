import { NextResponse } from "next/server";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { assertDisputeDecisionActor, decidePrivateCalendarDataDisputes } from "@/lib/private-calendar/disputes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "Accept all" / "Reject all" on one reason group of the Calendar Disputes inbox. Super Admin only —
// the domain helper's assertDisputeDecisionActor is the gate.
export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    // REC-080: the caller is judged before the body — the same Super Admin gate the decision asks.
    assertSignedIn(access);
    assertDisputeDecisionActor(access);
    const body = await request.json();
    const decision = body.decision === "accept" || body.decision === "reject" ? body.decision : null;
    if (!decision) throw validationError("decision must be 'accept' or 'reject'.");
    const disputeIds = Array.isArray(body.disputeIds) ? body.disputeIds.map((id: unknown) => String(id ?? "")) : [];
    const result = await decidePrivateCalendarDataDisputes(access, {
      decision,
      disputeIds,
      note: String(body.note ?? ""),
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to decide these requests.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
