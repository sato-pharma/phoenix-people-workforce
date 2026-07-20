import { jsonError, resolveAccessContext, xlsxResponse } from "@/lib/automated-payroll/http";
import { buildStepTemplate } from "@/lib/automated-payroll/run-service";
import { isStepKey } from "@/lib/automated-payroll/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Download the pre-populated per-step xlsx template. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string; stepKey: string }> },
) {
  try {
    const { runId, stepKey } = await params;
    if (!isStepKey(stepKey)) return jsonError(new Error("Validation: unknown step."));
    const access = await resolveAccessContext(request);
    const { buffer, fileName } = await buildStepTemplate(access, runId, stepKey);
    return xlsxResponse(buffer, fileName);
  } catch (error) {
    return jsonError(error, "Failed to export the step template.");
  }
}
