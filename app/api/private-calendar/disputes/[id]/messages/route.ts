import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import {
  addPrivateCalendarDisputeMessage,
  listPrivateCalendarDisputeMessages,
} from "@/lib/private-calendar/dispute-messages";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The thread on one review request. Both verbs are gated inside the domain helper on the SAME narrow
// rule — the employee who raised it, or a Super Admin — rather than on the attendance matrix, because
// a manager holding attendance:read must not be able to read or join a colleague's conversation.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const messages = await listPrivateCalendarDisputeMessages(access, id);
    return NextResponse.json({ data: messages, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to load this conversation.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json();
    const message = await addPrivateCalendarDisputeMessage(access, {
      body: String(body.body ?? ""),
      disputeId: id,
    });
    return NextResponse.json({ data: message, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Unable to send this reply.");
    return NextResponse.json({ error: apiError.code, message: apiError.message, success: false }, { status: apiError.status });
  }
}
