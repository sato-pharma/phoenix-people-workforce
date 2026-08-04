import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getPayrollDataQuality } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET: employees whose pay-determining data is missing or ambiguous on this run. */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const report = await getPayrollDataQuality(access, runId);
    return NextResponse.json({ success: true, report });
  } catch (error) {
    return jsonError(error, "Failed to load the payroll data-quality report.");
  }
}
