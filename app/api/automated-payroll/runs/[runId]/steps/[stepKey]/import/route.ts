import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { importStepUpload } from "@/lib/automated-payroll/run-service";
import { isStepKey } from "@/lib/automated-payroll/types";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseFormBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The step screen's upload (REC-060): the workbook, and the revision the screen loaded ("" = never saved), which
 * carries the run's cell watermark too (F-PAY-017). A file's own revision still wins over the screen's.
 */
const StepImportFormSchema = z.object({
  file: z.custom<File>((value) => value instanceof File, { message: "a file is required." }),
  revision: z.string().optional(),
});

/** Re-upload an edited step xlsx. ?commit=true applies; otherwise returns a dry-run diff preview. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ runId: string; stepKey: string }> },
) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    assertSignedIn(access); // REC-080: a signed-out caller is refused before the path or the file is judged.
    const { runId, stepKey } = await params;
    if (!isStepKey(stepKey)) return jsonError(new Error("Validation: unknown step."));
    // REC-080: the service's own gate, asked before the file is judged.
    assertAutomatedPayrollHrActor(access);

    const parsed = await parseFormBody(request, StepImportFormSchema);
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const { file, revision: revisionField } = parsed.data;
    const commit = new URL(request.url).searchParams.get("commit") === "true";
    // The step's revision on the uploading screen ("" = never saved); a file's own revision wins (finding 1).
    const screenRevision = revisionField === undefined ? undefined : revisionField || null;

    const result = await importStepUpload(access, runId, stepKey, file, commit, screenRevision);
    return NextResponse.json({ success: true, result });
  } catch (error) {
    return jsonError(error, "Failed to import the step file.");
  }
}
