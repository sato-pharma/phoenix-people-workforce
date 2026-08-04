import { NextResponse } from "next/server";

import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listHeldOutstationRequests } from "@/lib/outstation/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every outstation request currently held out of payroll by the two-photo + workload gate.
 *
 * Read-only, and scoped by listHeldOutstationRequests to the outstation admin roles — the
 * execution-only finance roles can see what is stuck without being able to change it.
 */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const unauthenticated = unauthenticatedSessionResponse(access);
    if (unauthenticated) return unauthenticated;

    const requests = await listHeldOutstationRequests(access);
    return NextResponse.json({ requests, success: true });
  } catch (error) {
    return NextResponse.json(
      {
        error: isForbiddenError(error) ? "forbidden" : "outstation_held_requests_failed",
        message: error instanceof Error ? error.message : "Unable to load held outstation requests.",
      },
      { status: isForbiddenError(error) ? 403 : 500 },
    );
  }
}
