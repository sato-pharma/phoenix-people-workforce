import { NextResponse } from "next/server";

import { acknowledgmentTokenFromError } from "@/lib/automated-payroll/acknowledgment-token";
import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  confirmPart2,
  DATA_QUALITY_ACK_REQUIRED,
  OVERPAID_ACK_REQUIRED,
  POPULATION_DIFF_ACK_REQUIRED,
} from "@/lib/automated-payroll/run-service";
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
    // Acknowledgements are SERVER-MINTED TOKENS, never booleans (audit finding 53): a caller cannot
    // say yes to a warning this server never showed it. A body that still sends the old
    // `acknowledgeOverpaid: true` flag is simply not an acknowledgement, and the gate fires.
    const body = (await request.json().catch(() => ({}))) as {
      acknowledgeOverpaidToken?: unknown;
      acknowledgeDataIssuesToken?: unknown;
      acknowledgePopulationDiffToken?: unknown;
    };
    const token = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : null);
    const run = await confirmPart2(access, runId, {
      acknowledgeOverpaidToken: token(body.acknowledgeOverpaidToken),
      acknowledgeDataIssuesToken: token(body.acknowledgeDataIssuesToken),
      acknowledgePopulationDiffToken: token(body.acknowledgePopulationDiffToken),
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
