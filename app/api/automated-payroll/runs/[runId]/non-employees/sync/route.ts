import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { syncRunFromRecurring } from "@/lib/automated-payroll/non-employee-recurring";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST: copy the standing Non-Employees Payroll roster into this run.
 *
 * A new run seeds itself at creation, so this is for the two cases that misses:
 * a run opened before the roster existed, and someone added to the roster after
 * the month was already open. Idempotent — an entry already on the run is left
 * exactly as it is, amount included.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const result = await syncRunFromRecurring(access, runId);
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return jsonError(error, "Failed to sync the standing roster into this run.");
  }
}
