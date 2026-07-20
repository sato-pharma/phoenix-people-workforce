import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getStepRecommendation, saveStep } from "@/lib/automated-payroll/run-service";
import type { StepEditInput } from "@/lib/automated-payroll/types";
import { isStepKey, type StepInputMode } from "@/lib/automated-payroll/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: the step's recommendation table (system recommendation overlaid with saved edits). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string; stepKey: string }> },
) {
  try {
    const { runId, stepKey } = await params;
    if (!isStepKey(stepKey)) return jsonError(new Error("Validation: unknown step."));
    const access = await resolveAccessContext(request);
    const result = await getStepRecommendation(access, runId, stepKey);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to load the step.");
  }
}

/** PUT: save inline/xlsx edits for the step (marks it edited, not confirmed). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ runId: string; stepKey: string }> },
) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId, stepKey } = await params;
    if (!isStepKey(stepKey)) return jsonError(new Error("Validation: unknown step."));
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as {
      edits?: StepEditInput[];
      inputMode?: StepInputMode;
    };
    const edits = Array.isArray(body.edits) ? body.edits : [];
    await saveStep(access, runId, stepKey, edits, body.inputMode === "xlsx" ? "xlsx" : "inline");
    return NextResponse.json({ success: true, saved: edits.length });
  } catch (error) {
    return jsonError(error, "Failed to save the step.");
  }
}
