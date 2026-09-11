import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getModuleDrift } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET: confirmed figures the Deductions module no longer agrees with.
 *
 * Read-only and deliberately not part of any confirm or publish gate — it answers a question,
 * it does not hold anything up. See module-drift.ts for why the comparison is against what the
 * module proposed at confirm rather than against the figure on the row.
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const report = await getModuleDrift(access, runId);
    return NextResponse.json({ success: true, report });
  } catch (error) {
    return jsonError(error, "Failed to load the Deductions-module drift report.");
  }
}
