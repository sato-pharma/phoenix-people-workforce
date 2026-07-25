import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getPopulationDiff } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: who joined / left / unexpectedly vanished vs. last month's published payroll. */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const diff = await getPopulationDiff(access, runId);
    return NextResponse.json({ success: true, diff });
  } catch (error) {
    return jsonError(error, "Failed to load the population diff.");
  }
}
