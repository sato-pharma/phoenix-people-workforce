import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getReconciliation } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const totals = await getReconciliation(access, runId);
    return NextResponse.json({ success: true, totals });
  } catch (error) {
    return jsonError(error, "Failed to reconcile the payroll run.");
  }
}
