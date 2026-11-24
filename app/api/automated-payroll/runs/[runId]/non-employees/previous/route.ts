import { NextResponse } from "next/server";
import { z } from "zod";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import {
  copyPreviousRunNonEmployees,
  previewPreviousRunNonEmployees,
} from "@/lib/automated-payroll/non-employee-recurring";
import { assertAutomatedPayrollHrActor } from "@/lib/automated-payroll/permissions";
import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { parseJsonBody } from "@/lib/http/request-body";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The people HR ticked on last month's list — the earlier run's row ids. */
const CopyBodySchema = z.object({
  ids: z.array(z.string().min(1)).max(200),
});

/**
 * GET: last published month's Non-Employees Payroll list, each person marked with whether they can be
 * copied into this run. Reads only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    const list = await previewPreviousRunNonEmployees(access, runId);
    return NextResponse.json({ success: true, ...list });
  } catch (error) {
    return jsonError(error, "Failed to load last month's Non-Employees Payroll.");
  }
}

/** POST: copy the ticked people into this run (and back onto the standing list when missing). */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    assertAutomatedPayrollHrActor(access);
    const parsed = await parseJsonBody(request, CopyBodySchema);
    if (!parsed.ok) return jsonError(new Error(`Validation: ${parsed.message}`));
    const result = await copyPreviousRunNonEmployees(access, runId, parsed.data.ids);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to copy last month's Non-Employees Payroll.");
  }
}
