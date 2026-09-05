import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getHoldReview } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: who this run is NOT paying, and why.
 *
 * A held row is dropped at publish and writes no payslip, so this is the last
 * screen on which the reason can still be read. `getHoldReview` re-checks the
 * caller itself (`assertAutomatedPayrollHrActor`) — the route is not the
 * boundary, the service is.
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const review = await getHoldReview(access, runId);
    return NextResponse.json({ success: true, review });
  } catch (error) {
    return jsonError(error, "Failed to load the held-employee review.");
  }
}
