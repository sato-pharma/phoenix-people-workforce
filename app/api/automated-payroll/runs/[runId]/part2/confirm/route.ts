import { NextResponse } from "next/server";
import { z } from "zod";

import { acknowledgmentTokenFromError } from "@/lib/automated-payroll/acknowledgment-token";
import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import {
  confirmPart2,
  DATA_QUALITY_ACK_REQUIRED,
  OVERPAID_ACK_REQUIRED,
  POPULATION_DIFF_ACK_REQUIRED,
} from "@/lib/automated-payroll/run-service";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The wizard sends each server-minted token it has earned (null for the rest) and the "Email them too"
 * box (REC-060). Any other key (an old boolean flag) is dropped by the schema and is no acknowledgement.
 */
const Part2ConfirmBodySchema = z.object({
  acknowledgeOverpaidToken: z.string().nullable().optional(),
  acknowledgeDataIssuesToken: z.string().nullable().optional(),
  acknowledgePopulationDiffToken: z.string().nullable().optional(),
  sendEmail: z.boolean().optional(),
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
    // Acknowledgements are SERVER-MINTED TOKENS, never booleans (audit finding 53): a caller cannot
    // say yes to a warning this server never showed it. A body that still sends the old
    // `acknowledgeOverpaid: true` flag is simply not an acknowledgement, and the gate fires.
    const parsed = await parseJsonBody(request, Part2ConfirmBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
    const token = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
    const run = await confirmPart2(access, runId, {
      acknowledgeOverpaidToken: token(body.acknowledgeOverpaidToken),
      acknowledgeDataIssuesToken: token(body.acknowledgeDataIssuesToken),
      acknowledgePopulationDiffToken: token(body.acknowledgePopulationDiffToken),
      // Only an explicit false skips the email; anything else sends it, as before.
      sendEmail: body.sendEmail !== false,
    });
    return NextResponse.json({ success: true, run });
  } catch (error) {
    // The overpayment gate is a decision point, not a failure: tell the client
    // explicitly that re-confirming with an acknowledgment is a valid next step,
    // so it can prompt instead of just showing a red error. Every other
    // Conflict (notably a split mismatch = calculation bug) stays a plain error.
    const message = clientSafeErrorMessage(error, "");
    // The token the fired gate minted, handed to the client so its retry can carry it back.
    const acknowledgmentToken = acknowledgmentTokenFromError(error);
    if (message.includes(DATA_QUALITY_ACK_REQUIRED)) {
      return NextResponse.json(
        {
          success: false,
          requiresDataQualityAcknowledgment: true,
          acknowledgmentToken,
          error: message.replace(/^conflict:\s*/i, "").replace(`${DATA_QUALITY_ACK_REQUIRED} `, ""),
        },
        { status: 409 },
      );
    }
    // Someone paid last month is missing with no resignation on file (audit finding 46).
    if (message.includes(POPULATION_DIFF_ACK_REQUIRED)) {
      return NextResponse.json(
        {
          success: false,
          requiresPopulationDiffAcknowledgment: true,
          acknowledgmentToken,
          error: message.replace(/^conflict:\s*/i, "").replace(`${POPULATION_DIFF_ACK_REQUIRED} `, ""),
        },
        { status: 409 },
      );
    }
    if (message.includes(OVERPAID_ACK_REQUIRED)) {
      return NextResponse.json(
        {
          success: false,
          requiresOverpaidAcknowledgment: true,
          acknowledgmentToken,
          error: message.replace(/^conflict:\s*/i, "").replace(`${OVERPAID_ACK_REQUIRED} `, ""),
        },
        { status: 409 },
      );
    }
    return jsonError(error, "Failed to confirm Part 2.");
  }
}
