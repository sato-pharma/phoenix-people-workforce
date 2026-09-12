import { NextResponse } from "next/server";

import { acknowledgmentTokenFromError } from "@/lib/automated-payroll/acknowledgment-token";
import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { confirmPart1, DATA_QUALITY_ACK_REQUIRED } from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    // The acknowledgement is a SERVER-MINTED TOKEN, never a boolean (audit finding 53): a caller
    // cannot say yes to a warning this server never showed it. A body still sending the old
    // `acknowledgeDataIssues: true` flag is simply not an acknowledgement, and the gate fires.
    const body = (await request.json().catch(() => ({}))) as { acknowledgeDataIssuesToken?: unknown };
    const run = await confirmPart1(access, runId, {
      acknowledgeDataIssuesToken:
        typeof body.acknowledgeDataIssuesToken === "string" && body.acknowledgeDataIssuesToken.length > 0
          ? body.acknowledgeDataIssuesToken
          : null,
    });
    return NextResponse.json({ success: true, run });
  } catch (error) {
    // Missing pay-determining data is a decision point, not a failure: tell the
    // client an acknowledged re-confirm is a valid next step so it can prompt
    // with the names, rather than showing a dead-end red error. Same contract as
    // the Part 2 overpayment gate.
    const message = clientSafeErrorMessage(error, "");
    if (message.includes(DATA_QUALITY_ACK_REQUIRED)) {
      return NextResponse.json(
        {
          success: false,
          requiresDataQualityAcknowledgment: true,
          // The token the fired gate minted, handed back so the client's retry can carry it.
          acknowledgmentToken: acknowledgmentTokenFromError(error),
          error: message.replace(/^conflict:\s*/i, "").replace(`${DATA_QUALITY_ACK_REQUIRED} `, ""),
        },
        { status: 409 },
      );
    }
    return jsonError(error, "Failed to confirm Part 1.");
  }
}
