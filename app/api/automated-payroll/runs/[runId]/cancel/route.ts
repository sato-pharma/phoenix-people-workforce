import { NextResponse } from "next/server";

import { jsonError, resolveAccessContext } from "@/lib/automated-payroll/http";
import { cancelRun } from "@/lib/automated-payroll/run-service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Body (optional): `{ "overrideDownloaded": true, "reason": "<why>" }` — cancel a run whose bank
 * files finance has already downloaded. Without it such a cancel is refused (409); see
 * src/lib/automated-payroll/bank-file-downloads.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { runId } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => null)) as { overrideDownloaded?: unknown; reason?: unknown } | null;
    const run = await cancelRun(access, runId, {
      overrideDownloaded:
        body?.overrideDownloaded === true ? { reason: typeof body.reason === "string" ? body.reason : null } : null,
    });
    return NextResponse.json({ success: true, run });
  } catch (error) {
    return jsonError(error, "Failed to cancel the payroll run.");
  }
}
