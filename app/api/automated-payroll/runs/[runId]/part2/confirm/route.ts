import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { confirmPart2, OVERPAID_ACK_REQUIRED } from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { acknowledgeOverpaid?: boolean };
    const run = await confirmPart2(access, runId, { acknowledgeOverpaid: body.acknowledgeOverpaid === true });
    return NextResponse.json({ success: true, run });
  } catch (error) {
    // The overpayment gate is a decision point, not a failure: tell the client
    // explicitly that re-confirming with an acknowledgment is a valid next step,
    // so it can prompt instead of just showing a red error. Every other
    // Conflict (notably a split mismatch = calculation bug) stays a plain error.
    const message = error instanceof Error ? error.message : "";
    if (message.includes(OVERPAID_ACK_REQUIRED)) {
      return NextResponse.json(
        {
          success: false,
          requiresOverpaidAcknowledgment: true,
          error: message.replace(/^conflict:\s*/i, "").replace(`${OVERPAID_ACK_REQUIRED} `, ""),
        },
        { status: 409 },
      );
    }
    return jsonError(error, "Failed to confirm Part 2.");
  }
}
