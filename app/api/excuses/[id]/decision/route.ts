import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  decideExcuseRequestAsManager,
  excuseErrorMessage,
  isExcusesSchemaMissing,
  parseExcuseDecision,
} from "@/lib/excuses/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A manager decides an excuse signed in, in the Action Center, through the POST below — the only
// way in. The unauthenticated GET that decided one from an emailed one-click link, with a token in
// the query string, was removed on 2026-10-26, as the vacation link was in #3274: the raw token
// was put in no email (the manager email's only button is "Review in Action Center"), so the GET
// could not be reached honestly, and a decision taken by a GET is one a link preview or a mail
// scanner can take. A GET to this address now answers 405.

function decisionRecordedMessage(status: string) {
  return status === "approved"
    ? "Manager review was recorded as approved. This 2-hour excuse will appear on the employee private calendar."
    : `Manager review was recorded as ${status}.`;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const decision = parseExcuseDecision(body.decision);
    if (!decision) {
      return NextResponse.json(
        { error: "invalid_decision", message: "Decision must be 'approve', 'reject', or 'return'.", success: false },
        { status: 400 },
      );
    }
    const comment = typeof body.comment === "string" ? body.comment.trim() || null : null;
    const result = await decideExcuseRequestAsManager(access, { requestId: id, decision, comment });
    return NextResponse.json({ success: true, data: result, message: decisionRecordedMessage(result.status) });
  } catch (error) {
    const message = isExcusesSchemaMissing(error)
      ? "Excuse database tables are not deployed yet."
      : excuseErrorMessage(error) || "Unable to decide excuse request.";
    const isForbidden = message.startsWith("Forbidden") || message.includes("not the assigned manager");
    return NextResponse.json(
      { error: "decision_failed", message, success: false },
      { status: isForbidden ? 403 : 400 },
    );
  }
}
