import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { getStepRecommendation, saveStep } from "@/lib/automated-payroll/run-service";
import type { StepEditInput } from "@/lib/automated-payroll/types";
import { isStepKey } from "@/lib/automated-payroll/types";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
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

/**
 * What the step screen saves (REC-060; recommendation-step.tsx, toEdits): one edit per row it shows, plus an
 * explicit zero per manual row removed. A figure the screen could not read reaches JSON as null (NaN), so a
 * figure is a number or null, as the service has always been handed. `inputMode` stays free text: anything but
 * "xlsx" is an inline save, as before.
 */
const FigureMapSchema = z.record(z.string(), z.number().nullable());
const StepEditSchema = z.object({
  hrId: z.string(),
  values: FigureMapSchema.optional(),
  reasons: z.record(z.string(), z.string()).optional(),
  selects: z.record(z.string(), z.string()).optional(),
  reason: z.string().nullable().optional(),
  onHold: z.boolean().optional(),
  recommended: FigureMapSchema.optional(),
});
const StepSaveBodySchema = z.object({
  edits: z.array(StepEditSchema).optional(),
  inputMode: z.string().optional(),
  /** The step's revision when the screen loaded it; a newer one refuses the save (finding 1, F-PAY-017). */
  revision: z.string().nullable().optional(),
});

/** PUT: save inline/xlsx edits for the step (marks it edited, not confirmed). */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ runId: string; stepKey: string }> },
) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    assertSignedIn(access); // REC-080: a signed-out caller is refused before the path is judged.
    const { runId, stepKey } = await params;
    if (!isStepKey(stepKey)) return jsonError(new Error("Validation: unknown step."));
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, StepSaveBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
    // A null figure is what the screen has always sent for one it could not read; the service reads it as before.
    const edits = (body.edits ?? []) as StepEditInput[];
    const expectedRevision =
      body.revision === null ? null : typeof body.revision === "string" ? body.revision : undefined;
    const { revision } = await saveStep(access, runId, stepKey, edits, body.inputMode === "xlsx" ? "xlsx" : "inline", {
      expectedRevision,
      revisionSource: "screen",
    });
    return NextResponse.json({ success: true, saved: edits.length, revision });
  } catch (error) {
    return jsonError(error, "Failed to save the step.");
  }
}
