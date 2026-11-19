import { NextResponse } from "next/server";
import { z } from "zod";

import { acknowledgmentTokenFromError } from "@/lib/automated-payroll/acknowledgment-token";
import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { confirmPart1, DATA_QUALITY_ACK_REQUIRED } from "@/lib/automated-payroll/run-service";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The wizard sends the server-minted token, or null before any warning was shown (REC-060). Any other
 * key (an old boolean flag) is dropped by the schema and is no acknowledgement.
 */
const Part1ConfirmBodySchema = z.object({
  acknowledgeDataIssuesToken: z.string().nullable().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    // The acknowledgement is a SERVER-MINTED TOKEN, never a boolean (audit finding 53): a caller
    // cannot say yes to a warning this server never showed it. A body still sending the old
    // `acknowledgeDataIssues: true` flag is simply not an acknowledgement, and the gate fires.
    const parsed = await parseJsonBody(request, Part1ConfirmBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
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
