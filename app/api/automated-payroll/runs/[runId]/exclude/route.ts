import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { excludeEmployeeFromRun } from "@/lib/automated-payroll/run-service";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{ hrId, reason }` from the wizard's exclude prompt (REC-060); the service refuses a blank one. */
const ExcludeBodySchema = z.object({
  hrId: z.string().optional(),
  reason: z.string().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    // REC-080: the service's own gate, asked before the body is judged.
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, ExcludeBodySchema, { fallback: {} });
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const body = parsed.data;
    const hrId = String(body.hrId ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    await excludeEmployeeFromRun(access, runId, hrId, reason);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error, "Failed to exclude the employee from this run.");
  }
}
