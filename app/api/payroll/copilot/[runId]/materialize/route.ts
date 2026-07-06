import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import {
  assertCopilotAccess,
  copilotErrorResponse,
  resolveCopilotActor,
} from "@/lib/payroll/copilot/access";
import { materializeRun } from "@/lib/payroll/copilot/service";
import { payrollBatchHref } from "@/lib/payroll/links";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Materialize the negotiated draft into the existing salary_batches machinery.
 * From here the standard payroll workflow (editable until Lock) takes over.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    assertCopilotAccess(access);
    const { runId } = await params;

    const result = await materializeRun(runId, resolveCopilotActor(access));
    return NextResponse.json({
      ...result,
      batchHref: payrollBatchHref(result.batchId),
    });
  } catch (error) {
    return copilotErrorResponse(error);
  }
}
