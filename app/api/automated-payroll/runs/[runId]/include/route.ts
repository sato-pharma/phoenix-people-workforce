import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { includeEmployeeInRun } from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const body = (await request.json().catch(() => ({}))) as { hrId?: string };
    const hrId = String(body.hrId ?? "").trim();
    const access = await resolveAccessContext(request);
    await includeEmployeeInRun(access, runId, hrId);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error, "Failed to re-include the employee in this run.");
  }
}
