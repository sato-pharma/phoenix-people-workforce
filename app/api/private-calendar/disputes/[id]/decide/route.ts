import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError, validationError } from "@/lib/http/api-errors";
import { decidePrivateCalendarDataDispute } from "@/lib/private-calendar/disputes";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const decision = body.decision === "accept" || body.decision === "reject" ? body.decision : null;
    if (!decision) throw validationError("decision must be 'accept' or 'reject'.");
    const dispute = await decidePrivateCalendarDataDispute(access, {
      decision,
      disputeId: id,
      note: String(body.note ?? ""),
    });
    return NextResponse.json({ data: dispute, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to decide this dispute.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
