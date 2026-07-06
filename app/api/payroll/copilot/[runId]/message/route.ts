import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
} from "@/lib/payroll/copilot/access";
import { CopilotError, proposeFromMessage } from "@/lib/payroll/copilot/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Parse the CEO's free-text reply into proposed actions. No mutation — the CEO
 * confirms the returned actions, which the /actions route then applies.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;

    const body = (await request.json().catch(() => ({}))) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      throw new CopilotError("A message is required.", 400);
    }

    const result = await proposeFromMessage(runId, text);
    return NextResponse.json(result);
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
