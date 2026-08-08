import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { excludeEmployeeFromRun } from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const body = (await request.json().catch(() => ({}))) as { hrId?: string; reason?: string };
    const hrId = String(body.hrId ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    const access = await resolveAccessContext(request);
    await excludeEmployeeFromRun(access, runId, hrId, reason);
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error, "Failed to exclude the employee from this run.");
  }
}
