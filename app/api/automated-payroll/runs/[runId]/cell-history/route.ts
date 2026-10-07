import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { getDraftCellHistory } from "@/lib/automated-payroll/run-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?hrId=: every recorded change to one employee's cells on this run — who, why, from which
 * step, the value before and after. Read-only; the history itself is written by a database trigger.
 */
export async function GET(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const hrId = new URL(request.url).searchParams.get("hrId")?.trim() ?? "";
    if (!hrId) throw new Error("Validation: name the employee (hrId) whose history to read.");
    const changes = await getDraftCellHistory(access, runId, hrId);
    return NextResponse.json({ success: true, changes });
  } catch (error) {
    return jsonError(error, "Failed to load the payroll cell history.");
  }
}
