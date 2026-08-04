import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { confirmPart1, DATA_QUALITY_ACK_REQUIRED } from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { acknowledgeDataIssues?: boolean };
    const run = await confirmPart1(access, runId, {
      acknowledgeDataIssues: body.acknowledgeDataIssues === true,
    });
    return NextResponse.json({ success: true, run });
  } catch (error) {
    // Missing pay-determining data is a decision point, not a failure: tell the
    // client an acknowledged re-confirm is a valid next step so it can prompt
    // with the names, rather than showing a dead-end red error. Same contract as
    // the Part 2 overpayment gate.
    const message = error instanceof Error ? error.message : "";
    if (message.includes(DATA_QUALITY_ACK_REQUIRED)) {
      return NextResponse.json(
        {
          success: false,
          requiresDataQualityAcknowledgment: true,
          error: message.replace(/^conflict:\s*/i, "").replace(`${DATA_QUALITY_ACK_REQUIRED} `, ""),
        },
        { status: 409 },
      );
    }
    return jsonError(error, "Failed to confirm Part 1.");
  }
}
