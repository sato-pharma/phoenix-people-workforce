import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { cancelRun } from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const run = await cancelRun(access, runId);
    return NextResponse.json({ success: true, run });
  } catch (error) {
    return jsonError(error, "Failed to cancel the payroll run.");
  }
}
