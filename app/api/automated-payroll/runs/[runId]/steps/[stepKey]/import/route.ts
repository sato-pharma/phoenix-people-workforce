import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { importStepUpload } from "@/lib/automated-payroll/run-service";
import { isStepKey } from "@/lib/automated-payroll/types";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Re-upload an edited step xlsx. ?commit=true applies; otherwise returns a dry-run diff preview. */
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

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return jsonError(new Error("Validation: a file is required."));
    const commit = new URL(request.url).searchParams.get("commit") === "true";
    // The step's revision on the uploading screen ("" = never saved); a file's own revision wins (finding 1).
    const revisionField = form.get("revision");
    const screenRevision = typeof revisionField === "string" ? revisionField || null : undefined;

    const result = await importStepUpload(access, runId, stepKey, file, commit, screenRevision);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return jsonError(error, "Failed to import the step file.");
  }
}
