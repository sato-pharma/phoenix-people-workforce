import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getPayrollDayCollisions } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: employee-days this run would charge twice.
 *
 * Read-only. The enforcement is at Part 2 confirm; this exists so the block is never the first
 * anybody hears of it — see day-collisions.ts.
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const collisions = await getPayrollDayCollisions(access, runId);
    return NextResponse.json({ success: true, collisions });
  } catch (error) {
    return jsonError(error, "Failed to load the double-charged day report.");
  }
}
