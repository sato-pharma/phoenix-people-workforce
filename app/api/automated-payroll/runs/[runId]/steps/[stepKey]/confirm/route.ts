import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { confirmStep } from "@/lib/automated-payroll/run-service";
import { isStepKey } from "@/lib/automated-payroll/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string; stepKey: string }> },
) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId, stepKey } = await params;
    if (!isStepKey(stepKey)) return jsonError(new Error("Validation: unknown step."));
    const access = await resolveAccessContext(request);
    const state = await confirmStep(access, runId, stepKey);
    return NextResponse.json({ success: true, state });
  } catch (error) {
    return jsonError(error, "Failed to confirm the step.");
  }
}
